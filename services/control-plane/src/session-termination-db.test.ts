import { expect, test } from 'bun:test';

test('the SQL allocation fence covers owner, active state, unended state, and exact binding in one transaction', async () => {
  const child = Bun.spawn(['bun', '-e', `
    const {mock}=await import('bun:test');
    const {PgDialect}=await import('drizzle-orm/pg-core');
    const queries=[],events=[],transactions=[];let matches=true;
    const tx={update:()=>({set:value=>({where:predicate=>({returning:async()=>{
      queries.push({value,predicate:new PgDialect().sqlToQuery(predicate)});
      return matches?[{sessionId:'session-1'}]:[];
    }})})}),insert:()=>({values:async value=>{events.push(value)}})};
    mock.module('./src/db',()=>({db:{transaction:async fn=>{transactions.push('begin');const result=await fn(tx);transactions.push('commit');return result}}}));
    const {SessionService}=await import('./src/sessions.ts');
    const first=await SessionService.endSessionIfCurrentAllocation('session-1','owner','2026-09-24T00:00:00.000Z');
    matches=false;
    const second=await SessionService.endSessionIfCurrentAllocation('session-1','owner','2026-09-24T00:00:00.000Z');
    console.log(JSON.stringify({first,second,queries,events,transactions}));
  `], { cwd: import.meta.dir + '/..', stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
  expect(result.first).toBe(true);
  expect(result.second).toBe(false);
  expect(result.queries[0].predicate.sql).toBe('(\"sessions\".\"session_id\" = $1 and \"sessions\".\"client_id\" = $2 and \"sessions\".\"status\" = $3 and \"sessions\".\"ended_at\" is null and \"sessions\".\"metadata\"->>\'sessionBoundAt\' = $4)');
  expect(result.queries[0].predicate.params).toEqual(['session-1', 'owner', 'active', '2026-09-24T00:00:00.000Z']);
  expect(result.queries[0].value.status).toBe('deleted');
  expect(result.events).toHaveLength(1);
  expect(result.events[0]).toMatchObject({ sessionId: 'session-1', eventType: 'deleted', timestamp: result.queries[0].value.endedAt });
  expect(result.transactions).toEqual(['begin', 'commit', 'begin', 'commit']);
});
