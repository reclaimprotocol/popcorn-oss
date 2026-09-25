import { expect, test } from 'bun:test';

test('pool-manager route authenticates handoff and publishes only reliably bound allocations', async () => {
  const child = Bun.spawn(['bun', '-e', `
    const {mock}=await import('bun:test');
    const sessions=new Map(); const patches=[]; const shuts=[]; let failBinding=false;
    mock.module('./src/services/db',()=>({DB:{getSession:async id=>sessions.get(id)||null,sessionExists:async id=>sessions.has(id),createSession:async(id,pod)=>{sessions.set(id,pod);return true},deleteSession:async id=>sessions.delete(id)}}));
    mock.module('./src/services/auth',()=>({Auth:{signToken:()=> 'test.jwt'}}));
    mock.module('./src/services/agones',()=>({Agones:{allocate:async()=>({gameServerName:'browser-1',address:'10.0.0.1',nodeName:'node',ports:[{name:'novnc',port:6080}]}),shutdownGameServer:async name=>shuts.push(name)}}));
    const runtimeUrl='http://10.0.0.1:6080/_popcorn/viewer-handoff-status';
    mock.module('./src/services/k8s',()=>({buildMetadataAnnotationsPatch:annotations=>({metadata:{annotations}}),K8s:{
      getPodMetadata:async()=>({uid:'pod-1',namespace:'default'}),patchPod:async()=>{},
      patchGameServer:async(ns,name,patch)=>{patches.push(patch);if(failBinding)throw Error('fixture binding failed')},
      waitForLiveViewE2eBinding:async(name,request,uid)=>({version:1,podUid:uid,podPublicKey:Buffer.alloc(32,3).toString('base64url'),...request}),
      inspectViewerHandoff:async()=>runtimeUrl,requestViewerHandoff:async()=>runtimeUrl,confirmViewerHandoff:async()=>runtimeUrl
    }}));
    mock.module('./src/services/clickhouse',()=>({ClickHouse:{createSessionBinding:async()=>{}}}));
    mock.module('./src/services/otel',()=>({OtelEvents:{sessionStart:async()=>{}}}));
    mock.module('./src/extension-proxy',()=>({closeProxyCdpSession:()=>{},presetExtensionProxy:async()=>{}}));
    globalThis.fetch=async()=>Response.json({version:1,state:'revoked',sessionId:'session-1',podUid:'pod-1',runtimeInstanceId:'a'.repeat(32)});
    const app=(await import('./index.ts')).default;
    const headers={Authorization:'Bearer test-service','Content-Type':'application/json'};
    const create=async(id,extra={})=>app.fetch(new Request('http://localhost/internal/sessions',{method:'POST',headers,body:JSON.stringify({sessionId:id,clientId:'owner',clientName:'Test',publicGatewayUrl:'https://gateway.test',...extra})}));
    const created=await create('session-1'); const createdBody=await created.json();
    const get=await app.fetch(new Request('http://localhost/internal/session/session-1',{headers}));
    const handoff=(body,hs=headers)=>app.fetch(new Request('http://localhost/internal/session/session-1/handoff',{method:'POST',headers:hs,body:JSON.stringify(body)}));
    const missing=await handoff({clientId:'owner',expectedPodUid:'pod-1'},{});
    const wrong=await handoff({clientId:'other',expectedPodUid:'pod-1'});
    const good=await handoff({clientId:'owner',expectedPodUid:'pod-1'});
    const oversized=await handoff({clientId:'owner',expectedPodUid:'x'.repeat(2000)});
    failBinding=true;
    const failed=await create('binding-failed');
    failBinding=false;
    const firstEncryptedPatch=patches.length;
    const encrypted=await create('encrypted',{liveViewE2e:{version:1,clientPublicKey:Buffer.alloc(32,4).toString('base64url')}});
    console.log(JSON.stringify({statuses:[created.status,get.status,missing.status,wrong.status,good.status,failed.status,encrypted.status,oversized.status],createdBody,getBody:await get.json(),receipt:await good.json(),cache:good.headers.get('Cache-Control'),failedPublished:sessions.has('binding-failed'),shuts,encryptedPatches:patches.slice(firstEncryptedPatch)}));
  `], {
    cwd: import.meta.dir + '/..', env: { ...process.env, POOL_MANAGER_SERVICE_AUTH_TOKEN: 'test-service',
      POOL_MANAGER_SESSION_EXTENSION_URLS: JSON.stringify({ podUid: 'https://override.invalid' }),
    }, stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
  expect(result.statuses).toEqual([200, 200, 401, 404, 200, 503, 200, 413]);
  expect(result.createdBody.podUid).toBe('pod-1');
  expect(result.getBody.podUid).toBe('pod-1');
  expect(result.receipt).toEqual({ success: true, sessionId: 'session-1', podUid: 'pod-1', viewerAccess: 'revoked', runtimeInstanceId: 'a'.repeat(32) });
  expect(result.cache).toBe('no-store');
  expect(result.failedPublished).toBe(false);
  expect(result.shuts).toEqual(['browser-1']);
  expect(result.encryptedPatches).toHaveLength(2);
  const first = result.encryptedPatches[0].metadata.annotations;
  const last = result.encryptedPatches[1].metadata.annotations;
  expect(first['popcorn.dev/session-bound-at']).toBe(last['popcorn.dev/session-bound-at']);
  expect(first['popcorn.dev/session-id']).toBe(last['popcorn.dev/session-id']);
});
