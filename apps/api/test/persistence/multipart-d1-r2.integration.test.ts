import {expect,it} from 'vitest';
import {createD1Fixture} from './d1-fixture';
import {initializeMultipartUpload,getMultipartUploadPartUrl,completeMultipartVideoUpload} from '../../src/repositories/multipart-upload-repository';
import {buildPendingUploadFileKey} from '../../src/lib/upload';
import {processExternalTasks} from '../../src/lib/external-tasks';
import type {Bindings} from '../../src/types/bindings';
it('completes a real local R2 upload through D1 state, signature generation and idempotent outbox confirmation',async()=>{
 const f=await createD1Fixture({r2:true});
 try{
  if(!f.bucket)throw new Error('R2 fixture missing');const env={DB:f.database,VIDEO_BUCKET:f.bucket,DEPLOYMENT_EDITION:'cloud',RUNTIME:'node',ENVIRONMENT:'production',USE_S3_STORAGE:'false',R2_ACCESS_KEY_ID:'test-access',R2_SECRET_ACCESS_KEY:'test-secret',R2_S3_ENDPOINT:'https://r2.example.test',R2_BUCKET_NAME:'media'} as unknown as Bindings;
  await f.database.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','owner','owner@example.test',0,0,0,3)").run();
  const file=buildPendingUploadFileKey('owner',3,'.mp4');await f.database.prepare("INSERT INTO videos(id,file,title,description,uploaded_at,transcript,status,error_message,user_id,source_type,source_url,youtube_video_id) VALUES(1,?,'Video','','2026-01-01','','uploading','','owner','uploaded','','')").bind(file).run();
  expect(await initializeMultipartUpload(env,1,'owner','video/mp4')).toEqual({part_size:64*1024*1024,part_count:1});
  const raw=await f.database.prepare('SELECT multipart_upload FROM videos WHERE id=1').first<string>('multipart_upload');const session=JSON.parse(raw!) as {uploadId:string};
  const signed=new URL((await getMultipartUploadPartUrl(env,1,'owner',1)).upload_url);expect(signed.searchParams.get('uploadId')).toBe(session.uploadId);expect(signed.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
  const part=await f.bucket.resumeMultipartUpload('media/'+file,session.uploadId).uploadPart(1,new Uint8Array([1,2,3]));
  expect(await completeMultipartVideoUpload(env,1,'owner',[part])).toEqual(expect.any(Number));expect(await completeMultipartVideoUpload(env,1,'owner',[part])).toBeNull();
  expect(await f.database.prepare("SELECT count(*) AS n FROM external_tasks WHERE kind='sqs_job'").first('n')).toBe(1);expect(await f.database.prepare('SELECT status,multipart_upload FROM videos WHERE id=1').first()).toEqual({status:'pending',multipart_upload:null});expect((await f.bucket.head('media/'+file))?.size).toBe(3);
  await f.database.prepare("UPDATE external_tasks SET available_at='2000-01-01' WHERE kind IN('storage_cleanup','multipart_abort','multipart_cleanup')").run();const tasks=await f.database.prepare("SELECT id FROM external_tasks WHERE kind IN('storage_cleanup','multipart_abort','multipart_cleanup')").all<{id:number}>();
  for(const task of tasks.results)expect(await processExternalTasks(env,{taskId:task.id,arm:false})).toMatchObject({completed:1,failed:0});expect((await f.bucket.head('media/'+file))?.size).toBe(3);
 }finally{await f.dispose();}
},30000);
