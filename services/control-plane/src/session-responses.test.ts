import { describe, expect, test } from 'bun:test';

describe('control-plane LiveView response contract', () => {
  test('preserves LiveView URLs for credentialed and admin create, fetch, and TTL flows', async () => {
    const child = Bun.spawn([
      'bun',
      '-e',
      `const {ClientService}=await import('./src/clients.ts');
       const {SessionService}=await import('./src/sessions.ts');
       ClientService.validateCredentials=async(id,secret)=>id==='client-test'&&secret==='secret-test';
       ClientService.getClient=async()=>({id:'client-test',name:'Credentialed client',active:true,allowedClusters:null,createdAt:new Date()});
       const stored=new Map();
       SessionService.getSession=async(id)=>stored.has(id)?[stored.get(id)]:[];
       SessionService.createSession=async(sessionId,clientId,clientName,clusterName,region)=>{
         stored.set(sessionId,{sessionId,clientId,clientName,clusterName,region,status:'active'});
       };
       SessionService.updateSessionMetadata=async(sessionId,metadata)=>{
         stored.set(sessionId,{...stored.get(sessionId),metadata});
       };
       const regional=(sessionId)=>({
         success:true,
         sessionId,
         url:'https://gateway.example/liveview/'+sessionId+'/restricted.jwt/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000',
         cdpUrl:'wss://gateway.example/cdp/'+sessionId+'/restricted.jwt/',
         apiUrl:'https://gateway.example/api/'+sessionId+'/internal.jwt/',
         vncUrl:'https://gateway.example/liveview/'+sessionId+'/restricted.jwt/liveview.html?resize=scale&reconnect=1&reconnect_delay=2000',
         vncWsUrl:'wss://gateway.example/liveview-ws/'+sessionId+'/restricted.jwt'
       });
       globalThis.fetch=async(input,init)=>{
         const url=new URL(String(input));
         const body=init?.body?JSON.parse(String(init.body)):null;
         const match=url.pathname.match(/\\/internal\\/session\\/([^/]+)(?:\\/ttl)?$/);
         return Response.json({
           ...regional(body?.sessionId||decodeURIComponent(match?.[1]||'')),
           ...(body?.expiresAt?{expiresAt:body.expiresAt}:{}),
         });
       };
       const app=(await import('./index.ts')).default;
       const clientHeaders={Authorization:'Bearer client-test:secret-test','Content-Type':'application/json'};
       const adminHeaders={Authorization:'Bearer admin-test-token','Content-Type':'application/json'};
       const clientCreate=await app.fetch(new Request('http://localhost/v1/sessions',{method:'POST',headers:clientHeaders,body:JSON.stringify({sessionId:'client-session'})}));
       const clientFetch=await app.fetch(new Request('http://localhost/v1/session/client-session',{headers:clientHeaders}));
       const clientTtl=await app.fetch(new Request('http://localhost/v1/session/client-session/ttl',{method:'PATCH',headers:clientHeaders,body:JSON.stringify({extendBySeconds:60})}));
       const adminCreate=await app.fetch(new Request('http://localhost/admin/sessions',{method:'POST',headers:adminHeaders,body:JSON.stringify({sessionId:'admin-session'})}));
       const adminFetch=await app.fetch(new Request('http://localhost/admin/session/admin-session',{headers:adminHeaders}));
       const adminTtl=await app.fetch(new Request('http://localhost/admin/session/admin-session/ttl',{method:'PATCH',headers:adminHeaders,body:JSON.stringify({extendBySeconds:60})}));
       console.log(JSON.stringify({
         statuses:[clientCreate.status,clientFetch.status,clientTtl.status,adminCreate.status,adminFetch.status,adminTtl.status],
         bodies:await Promise.all([clientCreate.json(),clientFetch.json(),clientTtl.json(),adminCreate.json(),adminFetch.json(),adminTtl.json()])
       }));`,
    ], {
      cwd: import.meta.dir + '/..',
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5432/popcorn',
        CONTROL_PLANE_SERVICE_AUTH_TOKEN: 'test-service-token',
        CONTROL_PLANE_ADMIN_TOKEN: 'admin-test-token',
        CONTROL_PLANE_REGIONS: JSON.stringify([{
          name: 'us-central1',
          clusterName: 'test-cluster',
          poolManagerUrl: 'http://pool-manager.local',
          publicGatewayUrl: 'https://gateway.example',
          enabled: true,
        }]),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(result.statuses).toEqual([200, 200, 200, 200, 200, 200]);
    for (const body of result.bodies) {
      expect(body.vncUrl).toMatch(/^https:\/\/gateway\.example\/liveview\/(client|admin)-session\/restricted\.jwt\/liveview\.html\?resize=scale&reconnect=1&reconnect_delay=2000$/);
      expect(body.vncWsUrl).toMatch(/^wss:\/\/gateway\.example\/liveview-ws\/(client|admin)-session\/restricted\.jwt$/);
      expect(body).toMatchObject({ region: 'us-central1', clusterName: 'test-cluster' });
    }
  });
});
