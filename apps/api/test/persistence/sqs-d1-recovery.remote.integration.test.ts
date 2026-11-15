import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe,it,expect} from 'vitest';
import pg from 'pg';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {PostgresSaver} from '@langchain/langgraph-checkpoint-postgres';
import * as schema from '../../src/db/schema';
import {createD1JobRepository} from '../../src/persistence/d1/job-repository';
import {createPostgresJobRepository} from '../../src/persistence/postgres/job-repository';
import type {Bindings} from '../../src/types/bindings';
import type {JobRepository} from '../../src/persistence/contracts/job-repository';
type JobIdentity=Parameters<JobRepository['claim']>[0];
import {loadMigrationSnapshot} from '../../scripts/d1-migration-manifest';
import {buildMigrationManifest,quoteMigrationIdentifier as q} from '../../scripts/migrations/d1/manifest';
import {readPrivateInput} from '../../scripts/migrations/d1/private-input';
import {restorePostwriteSnapshot,type RecoveryRows} from '../../scripts/migrations/d1/postwrite-recovery';
import {createD1Fixture} from './d1-fixture';
const queueConfig=process.env.PERSISTENCE_SQS_REPLAY_CONFIG,url=process.env.PERSISTENCE_TEST_DATABASE_URL;
type Delivery={id:string;body:JobIdentity;receipt:string;receiveCount:number};
describe.skipIf(!queueConfig||!url)('real isolated SQS across D1 recovery',()=>{
 it('replays queued messages after DB replacement and suppresses lost-ack and explicit duplicate deliveries',async()=>{
  const config=JSON.parse((await readPrivateInput(queueConfig!,65536)).toString()) as {nonce:string;expiresAt:string};if(!/^[a-f0-9]{32}$/.test(config.nonce)||!Number.isFinite(Date.parse(config.expiresAt))||Date.parse(config.expiresAt)<Date.now()||Date.parse(config.expiresAt)>Date.now()+2*3600_000)throw Error('Invalid or expired SQS test configuration');
  const python=process.env.PERSISTENCE_REPLAY_PYTHON??'python3',bridge=fileURLToPath(new URL('./sqs-replay-bridge.py',import.meta.url));
  const sqs=async<T>(action:string,parameters:Record<string,unknown>={}):Promise<T>=>{const input=JSON.stringify({config,action,...parameters});const stdout=await new Promise<string>((resolve,reject)=>{const child=execFile(python,[bridge],{timeout:20000,maxBuffer:256*1024},(error,out)=>error?reject(Error('Isolated SQS bridge failed')):resolve(out));child.stdin!.end(input);});return JSON.parse(stdout) as T;};
  expect(await sqs('validate')).toEqual({ownedQueue:true});
  const client=new pg.Client({connectionString:url}),name='recovery_'+randomUUID().replaceAll('-',''),chat=name+'_chat',fixture=await createD1Fixture(),saver=PostgresSaver.fromConnString(url!,{schema:chat}),pool=new pg.Pool({connectionString:url,options:'-c search_path='+name+',public',max:4});let created=false;
  try{
   await client.connect();await client.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');await client.query('CREATE SCHEMA '+q(name));created=true;await client.query('SET search_path TO '+q(name)+',public');await client.query((await generateMigration(generateDrizzleJson({}),generateDrizzleJson(schema))).map(s=>s.replaceAll('"public".','')).join('\n'));await saver.setup();
   const d1=fixture.database,jobs=createD1JobRepository(d1),done={jobId:'sqs-recovery-'+config.nonce+'-done',jobType:'transcribe',payloadSha256:'a'.repeat(64)},retry={...done,jobId:'sqs-recovery-'+config.nonce+'-retry'};
   const first=await jobs.claim(done);if(first.status!=='claimed')throw Error('Expected baseline lease');expect(await jobs.complete(done.jobId,first.leaseToken)).toBe(true);
   await sqs('send',{message:done});await sqs('send',{message:retry});const held=new Map<string,Delivery>();const until=Date.now()+30000;while(held.size<2&&Date.now()<until){for(const m of await sqs<Delivery[]>('receive')){expect([done.jobId,retry.jobId]).toContain(m.body.jobId);held.set(m.body.jobId,m);}}expect(held.size).toBe(2);
   const failed=await jobs.claim(held.get(retry.jobId)!.body);if(failed.status!=='claimed')throw Error('Expected D1 delivery lease');expect(await jobs.fail(retry.jobId,failed.leaseToken,'CONSUMER_STOPPED')).toBe(true);
   // Sole consumer is now stopped. Messages are not acknowledged before DB recovery.
   const manifest=buildMigrationManifest(await loadMigrationSnapshot(resolve('drizzle')),await loadMigrationSnapshot(resolve('drizzle-d1'))),rows=Object.fromEntries(await Promise.all(manifest.target_insert_order.map(async n=>[n,(await d1.prepare('SELECT * FROM '+q(n)).all()).results]))) as RecoveryRows;
   const states=(await d1.prepare('SELECT name,CAST(seq AS TEXT) seq FROM sqlite_sequence').all<{name:string;seq:string}>()).results,high=Object.fromEntries(manifest.target_insert_order.map(n=>[n,states.find(s=>s.name===n)?.seq??'0']));await restorePostwriteSnapshot({client,schema:name,checkpointSchema:chat,manifest,rows,vectors:[],writersFenced:true,sequenceHighWater:high});
   for(const m of held.values())await sqs('release',{receipt:m.receipt});const restored=createPostgresJobRepository({DATABASE_POOL:pool} as Bindings);expect(await restored.complete(retry.jobId,failed.leaseToken)).toBe(false);
   let newlyClaimed=0,lostAck=false,redeliveryObserved=false;const acknowledged=new Set<string>(),sent=new Set([...held.values()].map(m=>m.id));const end=Date.now()+45000;
   while((acknowledged.size<sent.size||!redeliveryObserved)&&Date.now()<end){for(const m of await sqs<Delivery[]>('receive')){expect([done.jobId,retry.jobId]).toContain(m.body.jobId);expect(m.body.payloadSha256).toBe(done.payloadSha256);const result=await restored.claim(m.body);if(result.status==='claimed'){expect(m.body.jobId).toBe(retry.jobId);newlyClaimed++;expect(await restored.complete(m.body.jobId,result.leaseToken)).toBe(true);lostAck=true;await sqs('release',{receipt:m.receipt});continue;}expect(result.status).toBe('completed');if(m.body.jobId===retry.jobId&&lostAck&&m.receiveCount>=3)redeliveryObserved=true;await sqs('delete',{receipt:m.receipt});acknowledged.add(m.id);}}
   expect(newlyClaimed).toBe(1);expect(redeliveryObserved).toBe(true);expect(acknowledged.size).toBe(2);
   const duplicateIds=new Set<string>();for(let i=0;i<12;i++)duplicateIds.add((await sqs<{id:string}>('send',{message:retry})).id);const duplicateAcks=new Set<string>(),endDuplicates=Date.now()+45000;while(duplicateAcks.size<duplicateIds.size&&Date.now()<endDuplicates){const messages=await sqs<Delivery[]>('receive');const claims=await Promise.all(messages.map(m=>restored.claim(m.body)));for(let i=0;i<messages.length;i++){expect(duplicateIds.has(messages[i].id)).toBe(true);expect(claims[i].status).toBe('completed');await sqs('delete',{receipt:messages[i].receipt});duplicateAcks.add(messages[i].id);}}expect(duplicateAcks.size).toBe(12);
   expect((await client.query('SELECT attempts FROM '+q(name)+'.job_executions WHERE job_id=$1',[retry.jobId])).rows[0].attempts).toBe(2);expect((await client.query('SELECT attempts FROM '+q(name)+'.job_executions WHERE job_id=$1',[done.jobId])).rows[0].attempts).toBe(1);expect(await sqs('receive')).toEqual([]);
  }finally{await saver.end();await pool.end();if(created){await client.query('DROP SCHEMA '+q(chat)+' CASCADE');await client.query('DROP SCHEMA '+q(name)+' CASCADE');}await client.end();await fixture.dispose();}
 },180000);
});
