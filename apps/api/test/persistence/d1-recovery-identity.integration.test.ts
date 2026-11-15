import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {describe,it,expect} from 'vitest';
import pg from 'pg';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {PostgresSaver} from '@langchain/langgraph-checkpoint-postgres';
import * as schema from '../../src/db/schema';
import {loadMigrationSnapshot} from '../../scripts/d1-migration-manifest';
import {buildMigrationManifest,quoteMigrationIdentifier as q} from '../../scripts/migrations/d1/manifest';
import {restorePostwriteSnapshot,type RecoveryRows} from '../../scripts/migrations/d1/postwrite-recovery';
import {createD1Fixture} from './d1-fixture';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
describe.skipIf(!url)('D1 recovery identity high-water integration',()=>{
 it('preserves deleted D1 IDs, existing PG heads and transactional rollback with GENERATED ALWAYS identities',async()=>{
  const client=new pg.Client({connectionString:url}),name='recovery_'+randomUUID().replaceAll('-',''),chat=name+'_chat',fixture=await createD1Fixture(),saver=PostgresSaver.fromConnString(url!,{schema:chat});let created=false;
  try{
   await client.connect();await client.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');await client.query('CREATE SCHEMA '+q(name));created=true;await client.query('SET search_path TO '+q(name)+',public');
   await client.query((await generateMigration(generateDrizzleJson({}),generateDrizzleJson(schema))).map(s=>s.replaceAll('"public".','')).join('\n'));await saver.setup();
   const manifest=buildMigrationManifest(await loadMigrationSnapshot(resolve('drizzle')),await loadMigrationSnapshot(resolve('drizzle-d1'))),db=fixture.database;
   await db.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,used_upload_bytes) VALUES('owner','owner','owner@example.invalid',0,0,0,0,0)").run();
   const insert=(id:number)=>db.prepare("INSERT INTO videos(id,file,title,description,uploaded_at,transcript,status,error_message,user_id,source_type,source_url,youtube_video_id) VALUES(?,'a.mp4','test','','2026-11-15T00:00:00.000Z','','completed','','owner','uploaded','','')").bind(id).run();
   await insert(1);await insert(500);await db.prepare('DELETE FROM videos WHERE id=500').run();
   const snapshot=async()=>Object.fromEntries(await Promise.all(manifest.target_insert_order.map(async n=>[n,(await db.prepare('SELECT * FROM '+q(n)).all()).results]))) as RecoveryRows;
   const high=async()=>{const states=(await db.prepare('SELECT name,CAST(seq AS TEXT) seq FROM sqlite_sequence').all()).results;return Object.fromEntries(manifest.target_insert_order.map(n=>[n,(()=>{const v=states.find(s=>s.name===n)?.seq;if(v===undefined)return '0';expect(typeof v).toBe('string');return v as string;})()]));};
   const restore=(rows:RecoveryRows,state:Record<string,string>)=>restorePostwriteSnapshot({client,schema:name,checkpointSchema:chat,manifest,rows,vectors:[],writersFenced:true,sequenceHighWater:state});
   const sequence=(await client.query('SELECT pg_get_serial_sequence($1,$2) n',[q(name)+'.videos','id'])).rows[0].n;
   await client.query('ALTER SEQUENCE '+sequence+' RESTART WITH 1001');
   const rows=await snapshot(),state=await high();expect(state.videos).toBe('500');await restore(rows,state);
   expect((await client.query('SELECT nextval($1)::text n',[sequence])).rows[0].n).toBe('1001');
   await insert(9000);await db.prepare('DELETE FROM videos WHERE id=9000').run();const later=await high();expect(later.videos).toBe('9000');await restore(rows,later);
   expect((await client.query('SELECT nextval($1)::text n',[sequence])).rows[0].n).toBe('9001');
   await restore(rows,later);expect((await client.query('SELECT nextval($1)::text n',[sequence])).rows[0].n).toBe('9002');
   const invalid={...later,videos:'invalid'};await expect(restore(rows,invalid)).rejects.toThrow('Recovery transaction failed');expect((await client.query('SELECT count(*)::int n FROM '+q(name)+'.videos')).rows[0].n).toBe(1);expect((await client.query('SELECT nextval($1)::text n',[sequence])).rows[0].n).toBe('9003');
  }finally{await saver.end();if(created){await client.query('DROP SCHEMA '+q(chat)+' CASCADE');await client.query('DROP SCHEMA '+q(name)+' CASCADE');}await client.end();await fixture.dispose();}
 },60000);
});
