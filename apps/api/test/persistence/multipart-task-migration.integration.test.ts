import {readFileSync,readdirSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {expect,it} from 'vitest';

it('preserves populated task rows and the historical sequence across the D1 task-kind migration',async()=>{
 const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('migration')}}",compatibilityDate:'2026-08-20',d1Databases:['DB']}));
 try{
  const db=await runtime.getD1Database('DB');
  const directory=new URL('../../drizzle-d1/',import.meta.url);
  const files=readdirSync(directory).filter(f=>f.endsWith('.sql')).sort();
  const apply=async(filename:string)=>{const statements=readFileSync(new URL(filename,directory),'utf8').split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean);for(let offset=0;offset<statements.length;offset+=25)await db.batch(statements.slice(offset,offset+25).map(s=>db.prepare(s)));};
  for(const file of files.filter(f=>f<'0013'))await apply(file);
  await db.prepare("INSERT INTO external_tasks(id,kind,payload,dedupe_key,attempts,locked_at,last_error) VALUES(5,'storage_cleanup','{\"file\":\"retained\"}','live',3,'2026-11-13T00:00:00.000Z','retry')").run();
  await db.prepare("INSERT INTO external_tasks(id,kind,payload,dedupe_key,completed_at,effect_applied_at) VALUES(20,'storage_cleanup','{}','done','2026-11-12','2026-11-12')").run();
  await db.prepare("INSERT INTO external_tasks(id,kind,payload,dedupe_key) VALUES(1000,'storage_cleanup','{}','pruned')").run();
  await db.prepare('DELETE FROM external_tasks WHERE id=1000').run();
  await db.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,used_upload_bytes) VALUES('owner','owner','migration@example.test',0,0,0,0,0)").run();
  await db.prepare("INSERT INTO video_courses(id,name,description,created_at,updated_at,user_id,display_order) VALUES(1,'Course','','2026-11-13','2026-11-13','owner',0)").run();
  await db.prepare("INSERT INTO lms_installations(id,owner_user_id,name,issuer,client_id,deployment_id,authorization_url,jwks_url,sync_token_hash) VALUES('install','owner','Install','issuer','client','deployment','https://auth.example','https://keys.example',?)").bind('a'.repeat(64)).run();
  await db.prepare("INSERT INTO lms_resources(id,installation_id,external_id,context_id,resource_link_id,generation,manifest_hash,enabled) VALUES('resource','install','external','context','link',1,'hash',0)").run();
  await db.prepare("INSERT INTO lti_material_operations(id,resource_id,course_id,source_generation,actor_key,action,request_hash,before_revision,after_revision,external_task_id) VALUES('operation','resource',1,1,?,'retry','hash','before','after',5)").bind('b'.repeat(64)).run();
  const operationBefore=await db.prepare("SELECT * FROM lti_material_operations WHERE id='operation'").first();
  const before=(await db.prepare('SELECT * FROM external_tasks ORDER BY id').all()).results;
  for(const file of files.filter(f=>f>='0013'))await apply(file);
  expect((await db.prepare('SELECT * FROM external_tasks ORDER BY id').all()).results).toEqual(before);
  expect(await db.prepare("SELECT * FROM lti_material_operations WHERE id='operation'").first()).toEqual(operationBefore);
  for(const kind of ['multipart_abort','multipart_cleanup']){
   const row=await db.prepare('INSERT INTO external_tasks(kind,payload,dedupe_key) VALUES(?,?,?) RETURNING id').bind(kind,'{}',kind).first<{id:number}>();
   expect(row!.id).toBeGreaterThan(1000);
  }
  await expect(db.prepare("INSERT INTO external_tasks(kind,payload,dedupe_key) VALUES('unknown','{}','invalid')").run()).rejects.toThrow();
  const indexes=(await db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='external_tasks'").all<{name:string}>()).results.map(row=>row.name);
  expect(indexes).toEqual(expect.arrayContaining(['external_tasks_video_job_idx','external_tasks_ready_idx','external_tasks_completed_idx','external_tasks_dedupe_key_key']));
 }finally{await runtime.dispose();}
},20000);

const postgresUrl=process.env.PERSISTENCE_TEST_DATABASE_URL;
it.skipIf(!postgresUrl)('preserves PostgreSQL tasks while expanding the task-kind constraint',async()=>{
 const {isolatedPostgres}=await import('./isolated-postgres');
 const fixture=await isolatedPostgres(postgresUrl!);
 try{
  await fixture.pool.query(`CREATE TABLE external_tasks(id bigserial PRIMARY KEY,kind text NOT NULL,payload jsonb NOT NULL,dedupe_key text NOT NULL UNIQUE,attempts integer NOT NULL DEFAULT 0,locked_at timestamptz,completed_at timestamptz,effect_applied_at timestamptz,CONSTRAINT external_tasks_kind_check CHECK(kind IN ('sqs_job','storage_cleanup','invitation_email')));
   INSERT INTO external_tasks(kind,payload,dedupe_key,attempts,locked_at) VALUES('storage_cleanup','{"file":"retained"}','live',3,'2026-11-13');
   INSERT INTO external_tasks(kind,payload,dedupe_key,completed_at,effect_applied_at) VALUES('storage_cleanup','{}','done','2026-11-12','2026-11-12');`);
  const before=(await fixture.pool.query('SELECT * FROM external_tasks ORDER BY id')).rows;
  const sql=readFileSync(new URL('../../drizzle/0065_cheerful_stryfe.sql',import.meta.url),'utf8');
  await fixture.pool.query(sql.replaceAll('--> statement-breakpoint',''));
  expect((await fixture.pool.query('SELECT * FROM external_tasks ORDER BY id')).rows).toEqual(before);
  for(const kind of ['multipart_abort','multipart_cleanup'])await fixture.pool.query("INSERT INTO external_tasks(kind,payload,dedupe_key) VALUES($1,'{}',$1)",[kind]);
  await expect(fixture.pool.query("INSERT INTO external_tasks(kind,payload,dedupe_key) VALUES('unknown','{}','invalid')")).rejects.toThrow();
 }finally{await fixture.dispose();}
});
