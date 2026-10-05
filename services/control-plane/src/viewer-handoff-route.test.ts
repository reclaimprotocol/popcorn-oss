import { expect, test } from 'bun:test';

test('public handoff route authenticates, resolves the owner region, and rejects spoofing', async () => {
  const child = Bun.spawn(['bun', '-e', `
    const {ClientService}=await import('./src/clients.ts');
    const {SessionService}=await import('./src/sessions.ts');
    ClientService.validateCredentials=async(id,secret)=>id==='owner'&&secret==='test-secret';
    ClientService.getClient=async()=>({id:'owner',name:'Test',active:true,allowedClusters:null});
    SessionService.getSession=async(id)=>[{sessionId:id,clientId:id==='other-session'?'other':'owner',status:'active',region:'test-region',metadata:{sessionBoundAt:'2026-09-24T10:00:00.000Z'}}];
    const calls=[];
    globalThis.fetch=async(url,options)=>{
      calls.push({url:String(url),headers:options.headers,body:JSON.parse(options.body)});
      return Response.json({success:true,sessionId:'session-1',podUid:'pod-1',viewerAccess:'revoked',runtimeInstanceId:'a'.repeat(32)});
    };
    const app=(await import('./index.ts')).default;
    const headers={Authorization:'Bearer owner:test-secret','Content-Type':'application/json'};
    const send=(id,body,hs=headers)=>app.fetch(new Request('http://localhost/v1/session/'+id+'/handoff',{method:'POST',headers:hs,body:JSON.stringify(body)}));
    const missing=await send('session-1',{expectedPodUid:'pod-1'},{});
    const wrong=await send('other-session',{expectedPodUid:'pod-1'});
    const spoof=await send('session-1',{expectedPodUid:'pod-1',clientId:'other'});
    const good=await send('session-1',{expectedPodUid:'pod-1'});
    const oversized=await send('session-1',{expectedPodUid:'x'.repeat(2000)});
    console.log(JSON.stringify({statuses:[missing.status,wrong.status,spoof.status,good.status,oversized.status],body:await good.json(),cache:good.headers.get('Cache-Control'),calls}));
  `], {
    cwd: import.meta.dir + '/..', env: {
      ...process.env, DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/popcorn',
      CONTROL_PLANE_SERVICE_AUTH_TOKEN: 'test-service',
      CONTROL_PLANE_REGIONS: JSON.stringify([{ name: 'test-region', clusterName: 'cluster', poolManagerUrl: 'http://pool.test', publicGatewayUrl: 'https://gateway.test', enabled: true }]),
    }, stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
  expect(result.statuses).toEqual([401, 404, 400, 200, 413]);
  expect(result.cache).toBe('no-store');
  expect(result.calls).toEqual([{ url: 'http://pool.test/internal/session/session-1/handoff', headers: { Authorization: 'Bearer test-service', 'Content-Type': 'application/json' }, body: { clientId: 'owner', expectedPodUid: 'pod-1' } }]);
  expect(result.body).toEqual({ success: true, sessionId: 'session-1', podUid: 'pod-1', viewerAccess: 'revoked', runtimeInstanceId: 'a'.repeat(32) });
});
