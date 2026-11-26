/** Opt-in isolated experiments. No network/provider latency or production RTO claim. */
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { hashPassword } from 'better-auth/crypto';
import { createD1Fixture } from './d1-fixture';
import { createD1Auth } from '../../src/persistence/d1/auth';
import { createD1JobRepository } from '../../src/persistence/d1/job-repository';
import { createD1ExternalTaskRepository } from '../../src/persistence/d1/external-task-repository';
import { createD1SceneSearchRepository } from '../../src/persistence/d1/scene-search';
import { embeddingFingerprint, resolveEmbeddingConfig } from '../../src/lib/embedding-contract';
import { streamRag } from '../../src/lib/rag';
import { chatCompletionResponse } from '../helpers/chat-completion-response';
import { requestBodyText } from '../helpers/request-body';
import { digest, distribution, frozenIdentity, measuredD1, timed, traces, type Trace } from '../../scripts/acceptance/measurement';
import type { Bindings } from '../../src/types/bindings';
import type { Vectorize } from '@cloudflare/workers-types';
const enabled = process.env.RUN_CURRENT_ACCEPTANCE === '1';
const vector = Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0);
const match = (id = 'physical-1', scene = 'scene-1', revision = 'r1') => ({ id, score: .99, metadata: { scene_id: scene, revision, user_id: 'owner', video_id: 1 } });
const environment = (database: D1Database) => ({ ENVIRONMENT: 'production', DEPLOYMENT_EDITION: 'cloud', PERSISTENCE_BACKEND: 'd1', DB: database,
  BETTER_AUTH_URL: 'https://acceptance.example.test', FRONTEND_URL: 'https://acceptance.example.test', CORS_ALLOW_ORIGIN: 'https://acceptance.example.test',
  BETTER_AUTH_SECRET: 'synthetic-acceptance-secret-012345678901234567890123',
  EMBEDDING_PROVIDER: 'workers-ai', EMBEDDING_PROFILE: 'embeddinggemma2', EMBEDDING_MODEL: '@cf/google/embeddinggemma-2',
  OPENAI_API_KEY: 'synthetic', OPENAI_BASE_URL: 'https://answer.acceptance.invalid/v1', LLM_MODEL: 'synthetic-answer' }) as Bindings;
async function seed(database: D1Database, count = 1) {
  for (const id of ['owner', 'foreign']) await database.prepare("INSERT INTO users(id,username,email,email_verified,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES(?,?,?,1,0,0,0,0)").bind(id,id,id+'@example.test').run();
  for (let id = 1; id <= count; id++) {
    await database.prepare("INSERT INTO videos(id,user_id,title,file,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id) VALUES(?,'owner',?,'object-1','','2026-11-25T00:00:00Z','','completed','','upload','','')").bind(id, 'Synthetic '+id).run();
  }
  const fingerprint=await embeddingFingerprint(resolveEmbeddingConfig(environment(database)));
  await database.prepare("INSERT INTO video_index_versions(video_id,revision) VALUES(1,'source1')").run();
  await database.prepare("INSERT INTO scene_index_runs(id,video_id,user_id,source_revision,dimensions,expected_scenes,status,embedding_fingerprint) VALUES('r1',1,'owner','source1',768,1,'published',?)").bind(fingerprint).run();
  await database.prepare("INSERT INTO video_index_heads(video_id,dimensions,run_id) VALUES(1,768,'r1')").run();
  await database.prepare("INSERT INTO scenes(id,video_id,content,start_time,end_time,dimensions,revision,vector_id) VALUES('scene-1',1,'Recovery keeps the current revision','00:01','00:02',768,'r1','physical-1')").run();
}
function save(name: string, report: unknown) {
  const directory = process.env.ACCEPTANCE_EVIDENCE_DIR;
  if (directory) writeFileSync(directory + '/' + name + '.json', JSON.stringify(report, null, 2) + '\n');
}
describe.skipIf(!enabled)('current 768 configuration isolated acceptance', () => {
  it('restores coherent local DB/object/index/delivery generation and tests resume safety', async () => {
    const source = await createD1Fixture({ r2: true }), target = await createD1Fixture({ r2: true });
    try {
      await seed(source.database);
      await source.bucket!.put('object-1', 'synthetic media');
      const jobs = createD1JobRepository(source.database);
      const completed = { jobId: 'already-completed', jobType: 'transcribe', payloadSha256: 'a'.repeat(64) };
      const pending = { ...completed, jobId: 'resume' };
      const claimed = await jobs.claim(completed); expect(claimed.status).toBe('claimed');
      if (claimed.status !== 'claimed') throw Error('lease');
      await jobs.complete(completed.jobId, claimed.leaseToken);
      const failed = await jobs.claim(pending); if (failed.status !== 'claimed') throw Error('lease');
      await jobs.fail(pending.jobId, failed.leaseToken, 'SYNTHETIC_INTERRUPTION');
      await source.database.prepare("INSERT INTO external_tasks(id,kind,payload,dedupe_key,completed_at) VALUES(1,'invitation_email','{}','sent-before-snapshot','2026-11-25T00:00:00Z'),(2,'invitation_email','{}','unknown-provider-outcome',NULL)").run();
      // No live writers exist: source is a private fixture; barrier is fixture ownership.
      const snapshotAt = Date.now(), snapshot: Record<string, Record<string, unknown>[]> = {};
      for (const table of ['users','videos','video_index_versions','scene_index_runs','video_index_heads','scenes','job_executions','external_tasks']) snapshot[table] = (await source.database.prepare('SELECT * FROM '+table).all()).results;
      const object = await (await source.bucket!.get('object-1'))!.text();
      const indexSnapshot = [{ ...match(), values: vector }];
      const queueSnapshot = [pending, pending, completed];
      const workflowSnapshot = { id: 'synthetic-search-run', stage: 'publication-pending', sourceRevision: 'r1' };
      const snapshotDigest = digest(JSON.stringify({ snapshot, object, indexSnapshot, queueSnapshot, workflowSnapshot }));
      await source.database.prepare("UPDATE videos SET title='post-snapshot-write' WHERE id=1").run();
      const failureAt = Date.now(), start = performance.now();
      for (const [table, rows] of Object.entries(snapshot)) for (const row of rows) {
        const columns = Object.keys(row); await target.database.prepare('INSERT INTO '+table+' ('+columns.join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')').bind(...Object.values(row)).run();
      }
      await target.bucket!.put('object-1', object);
      expect(await (await target.bucket!.get('object-1'))!.text()).toBe('synthetic media');
      expect(await target.bucket!.get('missing')).toBeNull();
      const index = { query: async () => ({ matches: [...indexSnapshot, ...indexSnapshot, match('missing','missing'), match('old','scene-1','r0')] }) } as unknown as Vectorize;
      const search = createD1SceneSearchRepository(target.database, index, 768, await embeddingFingerprint(resolveEmbeddingConfig(environment(target.database))));
      const input = { queryEmbedding: vector, userId: 'owner', videoIds: [1], limit: 20 };
      expect(await search.search(input)).toHaveLength(1);
      expect(await search.search({ ...input, userId: 'foreign' })).toEqual([]);
      const resumed = createD1JobRepository(target.database); let executions = 0;
      for (const message of queueSnapshot) { const lease = await resumed.claim(message); if (lease.status === 'claimed') { executions++; await resumed.complete(message.jobId, lease.leaseToken); } }
      expect(executions).toBe(1);
      expect(await resumed.claim({ ...pending, payloadSha256: 'b'.repeat(64) })).toEqual({status:'conflict'});
      expect(await resumed.complete(pending.jobId, failed.leaseToken)).toBe(false);
      const outbox = createD1ExternalTaskRepository(target.database), leases = await outbox.claim({limit:10});
      expect(leases.map(lease=>lease.id)).toEqual([2]);
      // Unknown email-provider outcome is quarantined, never automatically resent.
      await outbox.defer(leases[0], 60000);
      expect(await outbox.claim({limit:10})).toEqual([]);
      await target.database.prepare("DELETE FROM scenes WHERE id='scene-1'").run();
      expect(await search.search(input)).toEqual([]); // stale physical index cannot resurrect deleted DB evidence
      expect(workflowSnapshot.sourceRevision).toBe('r1');
      const restoreMs = performance.now()-start;
      save('current-recovery-local', { ...frozenIdentity(), snapshotDigest, snapshotAt, failureAt, restoreAndValidationMs: restoreMs,
        lossWindowMs: failureAt-snapshotAt, lostSyntheticWrites: 1, restoredTables: Object.keys(snapshot),
        checks: { objectHash: digest(object), missingObjectDetected: true, duplicateDeliveryExecutions: executions, staleLeaseRejected: true,
          identityConflictRejected: true, deletedEvidenceHidden: true, crossOwnerDenied: true, unknownExternalOutcomeDeferred: true },
        productionModified: false, approvedRpoMs: null, approvedRtoMs: null, businessComparison: 'pending stakeholder agreement',
        fidelity: { d1: 'actual local workerd binding and repository adapters', r2: 'actual local workerd binding',
          vectorize: '768-dimensional snapshot and adversarial query binding simulation; no remote ANN/visibility',
          queue: 'serialized duplicate deliveries replayed through real job lease repository; no managed queue drain',
          workflow: 'serialized stage/revision manifest only; no managed Workflow restart', outbox: 'actual repository; no external send' },
        excluded: ['Production RTO/RPO', 'Cloudflare managed Queue/Workflow state export/restart', 'all-table operational backup', 'provider consistency and network latency', 'external side effect delivery confirmation'],
      });
    } finally { await source.dispose(); await target.dispose(); }
  }, 120000);
  it('measures authenticated actual RAG orchestration across tenant scopes and concurrency', async () => {
    const fixture = await createD1Fixture();
    try {
      await seed(fixture.database, 1000);
      await fixture.database.prepare("INSERT INTO account(id,user_id,account_id,provider_id,password) VALUES('credential','owner','owner','credential',?)").bind(await hashPassword('Synthetic acceptance password 2026!')).run();
      const database = measuredD1(fixture.database), env = environment(database), auth = createD1Auth(env,database,'browser');
      const response = await auth.handler(new Request('https://acceptance.example.test/api/auth/sign-in/email', {method:'POST', headers:{origin:'https://acceptance.example.test','content-type':'application/json'}, body:JSON.stringify({email:'owner@example.test',password:'Synthetic acceptance password 2026!'})}));
      expect(response.status).toBe(200);
      const cookie = response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
      const session = () => timed('authentication',()=>auth.api.getSession({headers:new Headers({cookie}),query:{disableCookieCache:true,disableRefresh:true}}));
      env.AI = { run: async () => timed('embedding_provider',async()=>Response.json({data:[{index:0,embedding:vector}]})) } as unknown as Ai;
      env.SCENE_VECTORIZE_768 = {query: async () => timed('vectorize',async()=>({matches:[match(),match(),match('foreign','foreign'),match('stale','scene-1','r0')]}))} as unknown as Vectorize;
      vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        if (String(url) !== 'https://answer.acceptance.invalid/v1/chat/completions') throw Error('Unexpected outbound request');
        return timed('answer_provider', async()=> {
          const body = JSON.parse(requestBodyText(init.body));
          const searched = body.messages.some((message: {role:string})=>message.role==='tool');
          const message = searched ? {role:'assistant',content:JSON.stringify({segments:[{text:'Recovery keeps the current revision.',sourceIds:[1]}]})}
            : {role:'assistant',content:null,tool_calls:[{id:'search',type:'function',function:{name:'search_scenes',arguments:JSON.stringify({query:'What does recovery keep?',video_ids:null})}}]};
          return chatCompletionResponse({choices:[{finish_reason:searched?'stop':'tool_calls',message}]},body.stream,'chatcmpl-'+randomUUID());
        });
      });
      const results = [];
      const samples = Number(process.env.ACCEPTANCE_SAMPLES ?? 12);
      for (const size of [1,100,1000]) for (const concurrency of [1,4]) {
        const rows: Trace[] = [];
        const request = async () => {
          const trace: Trace = {stages:{},reads:0,writes:0,queries:0,phase:'authentication'};
          await traces.run(trace,async()=>{
            const start = performance.now(), current = await session(); expect(current?.user.id).toBe('owner');
            trace.phase='retrieval';
            let final = false;
            for await (const chunk of streamRag(env,{messages:[{role:'user',content:'What does recovery keep?'}],ownerUserId:current!.user.id,videoIds:Array.from({length:size},(_,i)=>i+1),locale:'en'})) {
              if ('part' in chunk && trace.firstAnswerMs === undefined) trace.firstAnswerMs=performance.now()-start;
              if ('final' in chunk) { expect(JSON.stringify(chunk.final)).toContain('Recovery keeps the current revision'); expect(chunk.final.answer.sources).toHaveLength(1); final=true; }
            }
            expect(final).toBe(true); trace.completeMs=performance.now()-start;
          });
          rows.push(trace);
        };
        // First request is cold logical agent construction only: fixture/auth/module caches already exist.
        await request(); const first = rows.shift()!;
        for(let offset=0;offset<samples;offset+=concurrency) await Promise.all(Array.from({length:Math.min(concurrency,samples-offset)},request));
        const stageNames = [...new Set(rows.flatMap(row=>Object.keys(row.stages)))];
        const stages = Object.fromEntries(stageNames.map(stage=>[stage,distribution(rows.map(row=>(row.stages[stage]??[]).reduce((a,b)=>a+b,0)))]));
        results.push({tenantVideoCount:size,concurrency,samples,coldLogical:first,warm:{completeMs:distribution(rows.map(row=>row.completeMs!)),firstAnswerMs:distribution(rows.map(row=>row.firstAnswerMs!)),stages,
          queryCount:distribution(rows.map(row=>row.queries)),dbRowsReadKnownSubset:distribution(rows.map(row=>row.reads)),dbQueriesWithoutReadMetadata:distribution(rows.map(row=>row.unavailableReadMetadata??0)),dbRowsWritten:distribution(rows.map(row=>row.writes)),
          operationCount:Object.fromEntries(stageNames.map(stage=>[stage,distribution(rows.map(row=>(row.stages[stage]??[]).length))])),failureRate:0},rawSamples:rows});
      }
      expect(await auth.api.getSession({headers:new Headers({cookie:'invalid'}),query:{disableCookieCache:true}})).toBeNull();
      const foreignSearch=createD1SceneSearchRepository(database,env.SCENE_VECTORIZE_768,768,await embeddingFingerprint(resolveEmbeddingConfig(env)));
      expect(await foreignSearch.search({queryEmbedding:vector,userId:'foreign',videoIds:[1],limit:20})).toEqual([]);
      const stageTotals: Record<string,number> = {};
      for(const result of results) for(const [stage,values] of Object.entries(result.warm.stages)) stageTotals[stage]=(stageTotals[stage]??0)+values.sum;
      save('current-rag-local',{...frozenIdentity(),inputSha256:digest('What does recovery keep?'),samplesPerCell:samples,results,stageTotals,
        dominantMeasuredOperation:Object.entries(stageTotals).sort((a,b)=>b[1]-a[1])[0][0],sqlChange:'none: simulated providers cannot rank production DB against inference/network',
        authorizationChecks:{invalidSessionDenied:true,crossOwnerDenied:true},quality:'exact fixture citation/content checks; not semantic recall or live model quality',productionModified:false,
        limits:['Authentication and agent composed in harness; HTTP route/course setup, rate limits and billing excluded', 'Real streamRag/MCP/embedding bridge/search repository and local D1; synthetic Vectorize/embedding/answer providers', 'DB rows_read available for all/run; first/raw lack result metadata and are counted only as operations', 'coldLogical is first new agent call per cell, not process/edge/provider cold start','Tenant scope scales 1/100/1000 selected videos; one relevant scene, not representative production corpus distribution','p99 of 12 samples is descriptive maximum, insufficient tail confidence','No approved business RAG SLO, no production dominant SQL inference']});
    } finally { vi.unstubAllGlobals(); await fixture.dispose(); }
  }, 240000);
});
