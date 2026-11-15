import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {generateDrizzleJson,generateMigration} from 'drizzle-kit/api';
import {users,videos,externalTasks} from '../../src/db/schema';
import {initializeMultipartUpload,getMultipartUploadPartUrl,completeMultipartVideoUpload} from '../../src/repositories/multipart-upload-repository';
import {buildPendingUploadFileKey} from '../../src/lib/upload';
import {processExternalTasks} from '../../src/lib/external-tasks';
import {createD1VideoMutationRepository} from '../../src/persistence/d1/video-mutation-repository';
import {createD1Fixture} from './d1-fixture';
import {isolatedPostgres} from './isolated-postgres';
import type {Bindings} from '../../src/types/bindings';
const media=vi.hoisted(()=>({create:vi.fn(),complete:vi.fn(),head:vi.fn(),sign:vi.fn(),abort:vi.fn(),remove:vi.fn(),visual:vi.fn()}));
vi.mock('../../src/integrations/media',async original=>({...await original<typeof import('../../src/integrations/media')>(),createR2MultipartUpload:media.create,completeR2MultipartUpload:media.complete,getR2ObjectSize:media.head,presignR2UploadPart:media.sign,abortR2MultipartUpload:media.abort,deleteR2Object:media.remove,deleteVisualChunks:media.visual}));
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
for(const backend of ['d1','postgres']as const){
 describe.skipIf(backend==='postgres'&&!url)(`${backend} multipart persistence contract`,()=>{
  let env:Bindings,file:string,objects:Map<string,number>,execute:(sql:string,args?:unknown[])=>Promise<void>,rows:(sql:string)=>Promise<Record<string,unknown>[]>,dispose:()=>Promise<void>,database:D1Database|undefined,loseCommitResponse:()=>void;
  beforeEach(async()=>{
   if(backend==='d1'){
    const f=await createD1Fixture();database=f.database;dispose=f.dispose;env={DB:f.database,DEPLOYMENT_EDITION:'cloud',RUNTIME:'node'} as Bindings;
    loseCommitResponse=()=>{
     const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(target,key){if(key==='bind')return(...values:unknown[])=>wrap(target.bind(...values));if(key==='all')return async()=>{const result=await target.all();if(lose){lose=false;throw new Error('lost commit response');}return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
     let lose=true;env.DB=new Proxy(f.database,{get(target,key){if(key==='prepare')return(sql:string)=>sql.startsWith('UPDATE videos SET multipart_upload=')?wrap(target.prepare(sql)):target.prepare(sql);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
    };
    execute=async(sql,args=[])=>{await f.database.prepare(sql).bind(...args).run();};rows=async(sql)=>(await f.database.prepare(sql).all<Record<string,unknown>>()).results;
   }else{
    const f=await isolatedPostgres(url!);dispose=f.dispose;env={DATABASE_POOL:f.pool,DEPLOYMENT_EDITION:'onprem'} as Bindings;
    let lose=false;loseCommitResponse=()=>{lose=true;};
    f.pool.on('acquire',client=>{
     if(!lose)return;const original=client.query.bind(client);
     // Drizzle uses the Promise overload; intercept the successful COMMIT's
     // response without changing what PostgreSQL actually committed.
     Object.defineProperty(client,'query',{configurable:true,value:async(...values:unknown[])=>{
      const result:unknown=await Reflect.apply(original,client,values);
      const text=typeof values[0]==='string'?values[0]:String((values[0] as {text?:string})?.text);
      if(text.trim().toLowerCase()==='commit'&&lose){lose=false;Object.defineProperty(client,'query',{configurable:true,value:original});throw new Error('lost commit response');}
      return result;
     }});
    });
    await f.pool.query((await generateMigration(generateDrizzleJson({}),generateDrizzleJson({users,videos,externalTasks}))).map(s=>s.replaceAll('"public".','')).join('\n'));
    execute=async(sql,args=[])=>{let i=0;await f.pool.query(sql.replaceAll('?',()=>`$${++i}`),args);};rows=async(sql)=>(await f.pool.query(sql)).rows;
   }
   await execute("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,used_upload_bytes) VALUES('owner','owner','owner@example.test',false,0,0,5,5)");
   file=buildPendingUploadFileKey('owner',5,'.mp4');await execute("INSERT INTO videos(id,file,title,description,uploaded_at,transcript,status,error_message,user_id,source_type,source_url,youtube_video_id) VALUES(1,?,'Video','','2026-01-01','','uploading','','owner','uploaded','','')",[file]);
   objects=new Map();let sequence=0;
   media.create.mockReset().mockImplementation(async()=>`upload-${++sequence}`);media.complete.mockReset().mockImplementation(async(_env,key)=>{objects.set(key,5);});media.head.mockReset().mockImplementation(async(_env,key)=>objects.get(key)??null);media.sign.mockReset().mockResolvedValue('https://parts.example/signed');media.abort.mockReset().mockResolvedValue(undefined);media.remove.mockReset().mockImplementation(async(_env,key)=>{objects.delete(key);});media.visual.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async()=>{vi.restoreAllMocks();await dispose?.();});
  const initialize=()=>initializeMultipartUpload(env,1,'owner','video/mp4');
  const parts=[{partNumber:1,etag:'a'.repeat(32)}];
  const complete=()=>completeMultipartVideoUpload(env,1,'owner',parts);
  const video=async()=>(await rows('SELECT status,multipart_upload,upload_heartbeat_at FROM videos WHERE id=1'))[0];
  const session=async()=>{const raw=(await video()).multipart_upload;return (typeof raw==='string'?JSON.parse(raw):raw)as{uploadId:string;partSize:number;contentType:string};};
  const jobs=async()=>rows("SELECT id FROM external_tasks WHERE kind='sqs_job'");
  const gc=async(advance=true)=>{if(advance)await execute("UPDATE external_tasks SET available_at='2000-01-01' WHERE kind IN('storage_cleanup','multipart_abort','multipart_cleanup') AND completed_at IS NULL");const results=[];for(const t of await rows("SELECT id FROM external_tasks WHERE kind IN('storage_cleanup','multipart_abort','multipart_cleanup') AND completed_at IS NULL"))results.push(await processExternalTasks(env,{taskId:Number(t.id),arm:false}));return results;};
  it('initializes once, resumes the same session and signs only its own parts',async()=>{
   expect(await initialize()).toEqual({part_size:64*1024*1024,part_count:1});expect(await initialize()).toEqual({part_size:64*1024*1024,part_count:1});expect(media.create).toHaveBeenCalledTimes(1);expect(await getMultipartUploadPartUrl(env,1,'owner',1)).toEqual({upload_url:'https://parts.example/signed'});expect(media.sign).toHaveBeenCalledWith(env,file,(await session()).uploadId,1,'video/mp4',5);expect((await video()).upload_heartbeat_at).not.toBeNull();
  });
  it('serializes concurrent initialization and retains only one active session',async()=>{
   await Promise.all([initialize(),initialize(),initialize()]);const active=(await session()).uploadId;if(backend==='postgres')expect(media.create).toHaveBeenCalledTimes(1);else expect(media.create.mock.calls.length).toBeLessThanOrEqual(3);expect(active).toBeTruthy();objects.set(file,5);await gc();expect(objects.get(file)).toBe(5);expect(media.abort.mock.calls.every(c=>c[2]!==active)).toBe(true);expect((await rows("SELECT used_storage_bytes FROM users WHERE id='owner'"))[0].used_storage_bytes).toEqual(backend==='postgres'?'5':5);
  });
  it('preserves an adopted session when the initialization commit response is lost',async()=>{
   loseCommitResponse();await expect(initialize()).rejects.toThrow(backend==='postgres'?'commit':'lost commit response');const active=await session();expect(active.uploadId).toBeTruthy();await initialize();expect(media.create).toHaveBeenCalledTimes(1);objects.set(file,5);await gc();expect(media.abort).not.toHaveBeenCalled();expect(objects.get(file)).toBe(5);
  });
  it('signs the exact final part length and rejects invalid part numbers',async()=>{
   file=buildPendingUploadFileKey('owner',64*1024*1024+3,'.mp4');await execute('UPDATE videos SET file=? WHERE id=1',[file]);await initialize();await getMultipartUploadPartUrl(env,1,'owner',2);expect(media.sign.mock.calls[0][5]).toBe(3);
   for(const part of [0,3,1.5])await expect(getMultipartUploadPartUrl(env,1,'owner',part)).rejects.toThrow('part');
  });
  it('confirms one processing task and makes completion retries idempotent',async()=>{
   await initialize();expect(await complete()).toEqual(expect.any(Number));expect(await complete()).toBeNull();expect(await jobs()).toHaveLength(1);expect(await video()).toMatchObject({status:'pending',multipart_upload:null,upload_heartbeat_at:null});expect(media.complete).toHaveBeenCalledTimes(1);await gc();expect(objects.get(file)).toBe(5);
  });
  it('recovers a completed object after a lost storage response or database commit',async()=>{
   await initialize();objects.set(file,5);expect(await complete()).toEqual(expect.any(Number));expect(media.complete).not.toHaveBeenCalled();expect(await jobs()).toHaveLength(1);
  });
  it('recovers a lost completion response using the actual stored object size',async()=>{
   await initialize();media.complete.mockImplementationOnce(async(_env,key)=>{objects.set(key,5);throw new Error('lost storage response');});expect(await complete()).toEqual(expect.any(Number));expect(await jobs()).toHaveLength(1);expect(media.complete).toHaveBeenCalledTimes(1);
  });
  it('does not queue processing for incorrect object size',async()=>{
   await initialize();objects.set(file,6);await expect(complete()).rejects.toThrow('size');await expect(complete()).rejects.toThrow('size');if(backend==='d1')expect(await rows("SELECT id FROM external_tasks WHERE kind IN('storage_cleanup','multipart_abort','multipart_cleanup')")).toHaveLength(1);expect((await video()).status).toBe('uploading');expect(await jobs()).toEqual([]);
  });
  it.each([{parts:[{partNumber:1,etag:'bad\nheader'}]},{parts:[{partNumber:2,etag:'a'.repeat(32)}]},{parts:[]}])('rejects missing, nonsequential or invalid ETags (%j)',async({parts:requested})=>{
   await initialize();await expect(completeMultipartVideoUpload(env,1,'owner',requested)).rejects.toThrow();expect(media.head).not.toHaveBeenCalled();expect(await jobs()).toEqual([]);
  });
  it('rejects other owners and already confirmed initialization or signing',async()=>{
   await expect(initializeMultipartUpload(env,1,'peer','video/mp4')).rejects.toMatchObject({code:'NOT_FOUND'});await initialize();await complete();await expect(initialize()).rejects.toThrow('confirmed');await expect(getMultipartUploadPartUrl(env,1,'owner',1)).rejects.toThrow('active');
  });
  it('rolls back job insertion when the status transition fails, then recovers without completing storage again',async()=>{
   await initialize();if(backend==='d1')await execute("CREATE TRIGGER fail_pending BEFORE UPDATE ON videos WHEN NEW.status='pending' BEGIN SELECT RAISE(ABORT,'pending failure'); END");else await execute("CREATE FUNCTION fail_pending() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='pending' THEN RAISE EXCEPTION 'pending failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_pending BEFORE UPDATE ON videos FOR EACH ROW EXECUTE FUNCTION fail_pending()");
   await expect(complete()).rejects.toThrow();expect((await video()).status).toBe('uploading');expect(await jobs()).toEqual([]);await execute('DROP TRIGGER fail_pending'+(backend==='postgres'?' ON videos':''));expect(await complete()).toEqual(expect.any(Number));expect(media.complete).toHaveBeenCalledTimes(1);expect(await jobs()).toHaveLength(1);
  });
  if(backend==='d1')it('retains delayed cleanup while completion is unresolved, then collects a late object after deletion',async()=>{
   await initialize();media.complete.mockImplementationOnce(async(_env,key)=>{
    const deferred=await gc();expect(deferred[0]).toMatchObject({claimed:1,completed:0,failed:0});const tasks=await rows("SELECT completed_at,locked_at FROM external_tasks WHERE dedupe_key LIKE 'multipart-finish:%'");expect(tasks[0]).toMatchObject({completed_at:null,locked_at:null});
    const deleted=await createD1VideoMutationRepository(database!).delete(1,'owner');expect(deleted.deleted).toBe(true);await gc(false);objects.set(key,5);
   });
   await expect(complete()).rejects.toMatchObject({code:'NOT_FOUND'});expect(await jobs()).toEqual([]);expect(objects.get(file)).toBe(5);await gc();expect(objects.has(file)).toBe(false);expect((await rows("SELECT used_storage_bytes FROM users WHERE id='owner'"))[0].used_storage_bytes).toBe(0);
  });
 });
}
