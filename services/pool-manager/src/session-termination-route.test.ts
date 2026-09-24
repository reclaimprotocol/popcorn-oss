import { expect, test } from 'bun:test';
import { Hono } from 'hono';

test('an old pool manager returns 404 without invoking the legacy delete route', async () => {
  const oldServer = new Hono();
  let legacyDeletes = 0;
  oldServer.delete('/internal/session/:id', c => { legacyDeletes++; return c.json({ success: true }); });
  const response = await oldServer.request('/internal/session/session-1/allocation', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'owner', expectedPodUid: 'pod-1', expectedBoundAt: '2026-09-24T00:00:00.000Z' }),
  });
  expect(response.status).toBe(404);
  expect(legacyDeletes).toBe(0);
});

test('regional DELETE rejects stale maintenance ownership and preserves bodyless shutdown', async () => {
  const child = Bun.spawn(['bun', '-e', `
    const {mock}=await import('bun:test');
    const boundAt='2026-09-24T00:00:00.000Z';let mode='good',shutdowns=0,normal=0;
    let current={name:'browser-1',namespace:'default',podUid:'pod-1',clientId:'owner',boundAt,url:'http://10.0.0.1:9222'};
    mock.module('./src/services/db',()=>({DB:{getSession:async()=>({...current}),deleteSession:async()=>{},deleteSessionIfCurrent:async(id,expected)=>JSON.stringify(current)===JSON.stringify(expected)}}));
    mock.module('./src/services/auth',()=>({Auth:{}}));
    mock.module('./src/services/agones',()=>({Agones:{shutdownGameServer:async()=>{normal++}}}));
    mock.module('./src/services/k8s',()=>({buildMetadataAnnotationsPatch:()=>({}),K8s:{shutdownCurrentAllocation:async allocation=>{shutdowns++;if(allocation.podUid!=='pod-1')throw Error('bad UID');if(mode==='replace')current={...current,podUid:'replacement'}}}}));
    mock.module('./src/services/clickhouse',()=>({ClickHouse:{}}));
    mock.module('./src/services/otel',()=>({OtelEvents:{sessionEnd:async()=>{}}}));
    mock.module('./src/extension-proxy',()=>({closeProxyCdpSession:()=>{},presetExtensionProxy:async()=>{}}));
    globalThis.fetch=async()=>Response.json({sampleCount:0});
    const app=(await import('./index.ts')).default;
    const headers={Authorization:'Bearer test-service','Content-Type':'application/json'};
    const body={clientId:'owner',expectedPodUid:'pod-1',expectedBoundAt:boundAt};
    const send=(payload,hs=headers)=>app.fetch(new Request('http://localhost/internal/session/session-1'+(payload===undefined?'':'/allocation'),{method:'DELETE',headers:hs,...(payload===undefined?{}:{body:JSON.stringify(payload)})}));
    const missing=await send(body,{});const wrong=await send({...body,clientId:'other'});
    const stale=await send({...body,expectedPodUid:'replacement'});const good=await send(body);
    mode='replace';const raced=await send(body);const legacy=await send(undefined);
    console.log(JSON.stringify({statuses:[missing.status,wrong.status,stale.status,good.status,raced.status,legacy.status],body:await good.json(),cache:good.headers.get('Cache-Control'),shutdowns,normal,current}));
  `], { cwd: import.meta.dir + '/..', env: { ...process.env, POOL_MANAGER_SERVICE_AUTH_TOKEN: 'test-service' }, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
  expect(result.statuses).toEqual([401, 404, 409, 200, 409, 200]);
  expect(result.body).toMatchObject({ success: true, podUid: 'pod-1', shutdownAcknowledged: true, allocationReleased: true });
  expect(result.shutdowns).toBe(2);
  expect(result.normal).toBe(1);
  expect(result.current.podUid).toBe('replacement');
});
