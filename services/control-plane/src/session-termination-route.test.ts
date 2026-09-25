import { expect, test } from 'bun:test';
import { Hono } from 'hono';

test('an old control plane returns 404 without invoking the legacy delete route', async () => {
  const oldServer = new Hono();
  let legacyDeletes = 0;
  oldServer.delete('/v1/session/:id', c => { legacyDeletes++; return c.json({ success: true }); });
  const response = await oldServer.request('/v1/session/session-1/allocation', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedPodUid: 'pod-1' }),
  });
  expect(response.status).toBe(404);
  expect(legacyDeletes).toBe(0);
});

test('public DELETE keeps legacy semantics and strictly fences maintenance requests', async () => {
  const child = Bun.spawn(['bun', '-e', `
    const {ClientService}=await import('./src/clients.ts');
    const {SessionService}=await import('./src/sessions.ts');
    ClientService.validateCredentials=async(id,secret)=>id==='owner'&&secret==='test-secret';
    ClientService.getClient=async()=>({id:'owner',name:'Test',active:true,allowedClusters:null});
    const boundAt='2026-09-24T00:00:00.000Z'; let currentBoundAt=boundAt,mode='good',normalEnds=0,guardedEnds=0;
    SessionService.getSession=async id=>[{sessionId:id,clientId:id==='other'?'other':'owner',status:'active',region:'test-region',metadata:{sessionBoundAt:currentBoundAt}}];
    SessionService.endSession=async()=>{normalEnds++;return true};
    SessionService.endSessionIfCurrentAllocation=async(id,owner,bound)=>{if(owner!=='owner'||bound!==currentBoundAt)return false;guardedEnds++;return true};
    const calls=[];
    globalThis.fetch=async(url,options)=>{
      const body=options.body?JSON.parse(options.body):null;calls.push({url:String(url),method:options.method,body});
      if(!body||mode==='old-server')return Response.json({success:true,deleted:true});
      if(mode==='replace')currentBoundAt='2026-09-24T01:00:00.000Z';
      return Response.json({success:true,sessionId:'session-1',podUid:body.expectedPodUid,boundAt:body.expectedBoundAt,shutdownAcknowledged:true,allocationReleased:true});
    };
    const app=(await import('./index.ts')).default;
    const headers={Authorization:'Bearer owner:test-secret','Content-Type':'application/json'};
    const send=(body,hs=headers,id='session-1')=>app.fetch(new Request('http://localhost/v1/session/'+id+(body===undefined?'':'/allocation'),{method:'DELETE',headers:hs,...(body===undefined?{}:{body:JSON.stringify(body)})}));
    const missing=await send({expectedPodUid:'pod-1'},{});
    const other=await send({expectedPodUid:'pod-1'},headers,'other');
    const spoof=await send({expectedPodUid:'pod-1',clientId:'other'});
    const good=await send({expectedPodUid:'pod-1'});
    mode='old-server';const old=await send({expectedPodUid:'pod-1'});
    mode='replace';const raced=await send({expectedPodUid:'pod-1'});
    mode='good';const legacy=await send(undefined);
    const oversized=await send({expectedPodUid:'x'.repeat(2000)});
    console.log(JSON.stringify({statuses:[missing.status,other.status,spoof.status,good.status,old.status,raced.status,legacy.status,oversized.status],body:await good.json(),cache:good.headers.get('Cache-Control'),calls,normalEnds,guardedEnds}));
  `], { cwd: import.meta.dir + '/..', env: {
    ...process.env, DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/popcorn', CONTROL_PLANE_SERVICE_AUTH_TOKEN: 'test-service',
    CONTROL_PLANE_REGIONS: JSON.stringify([{ name: 'test-region', clusterName: 'cluster', poolManagerUrl: 'http://pool.test', publicGatewayUrl: 'https://gateway.test', enabled: true }]),
  }, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
  expect(result.statuses).toEqual([401, 404, 400, 200, 502, 409, 200, 413]);
  expect(result.body).toEqual({ success: true, sessionId: 'session-1', podUid: 'pod-1', shutdownAcknowledged: true, allocationReleased: true });
  expect(result.cache).toBe('no-store');
  expect(result.calls[0]).toEqual({ url: 'http://pool.test/internal/session/session-1/allocation', method: 'DELETE', body: { clientId: 'owner', expectedPodUid: 'pod-1', expectedBoundAt: '2026-09-24T00:00:00.000Z' } });
  expect(result.calls.at(-1).body).toBeNull();
  expect(result.normalEnds).toBe(1);
  expect(result.guardedEnds).toBe(1);
});
