import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { AwsClient } from 'aws4fetch';
import { describe, expect, it } from 'vitest';
import { migrateDatabase } from '../scripts/migrate-database';

const databaseUrl=process.env.PERSISTENCE_TEST_DATABASE_URL;
const endpoint=process.env.SQS_TEST_ENDPOINT;
const enabled=process.env.BACKGROUND_WORKER_E2E==='1'&&!!databaseUrl&&!!endpoint;
(enabled?describe:describe.skip)('built Node worker with actual PostgreSQL and ElasticMQ',()=>{
  it('indexes and completes a video, deduplicates delivery, then deletes a permanently banned account',async()=>{
    const admin=new pg.Client({connectionString:databaseUrl});await admin.connect();
    const name=`videoq_background_${crypto.randomUUID().replaceAll('-','')}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    const url=new URL(databaseUrl!);url.pathname=`/${name}`;
    const db=new pg.Client({connectionString:url.href});await db.connect();
    const aws=new AwsClient({accessKeyId:'local',secretAccessKey:'local',service:'sqs',region:'us-east-1',retries:0});
    async function request(operation:string,body:Record<string,unknown>){
      const response=await aws.fetch(endpoint!,{method:'POST',headers:{'content-type':'application/x-amz-json-1.0','x-amz-target':`AmazonSQS.${operation}`},body:JSON.stringify(body)});
      if(!response.ok)throw new Error(`SQS test ${operation}: ${response.status}`);
      const text=await response.text();return text?JSON.parse(text):{};
    }
    let modelCalls=0;
    let modelError: unknown;
    const model=createServer((req,res)=>{
      void (async()=>{
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const input=JSON.parse(Buffer.concat(chunks).toString()) as {input:string[]};modelCalls++;
      expect(input.input.every(text=>text.startsWith('title: none | text: '))).toBe(true);
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({data:input.input.map((_,index)=>({index,embedding:[1,...Array(767).fill(0)]}))}));
      })().catch(error=>{modelError=error;res.writeHead(500);res.end();});
    });
    model.listen(0,'127.0.0.1');await once(model,'listening');
    const address=model.address();if(!address||typeof address==='string')throw new Error('Missing model port');
    let child:ReturnType<typeof spawn>|undefined;
    let logs='';
    const queues:string[]=[];
    try{
      await migrateDatabase(db,{writersStopped:true});
      for(const group of ['search','account'])queues.push((await request('CreateQueue',{QueueName:`${name}-${group}`})).QueueUrl);
      await db.query("INSERT INTO users(id,email,username,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('index-owner','index@example.invalid','index-owner',false,0,0,0),('delete-owner','delete@example.invalid','delete-owner',false,0,0,0)");
      await db.query("UPDATE users SET banned=true,ban_expires=null WHERE id='delete-owner'");
      await db.query("INSERT INTO videos(id,user_id,title,file,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id) VALUES(1,'index-owner','Synthetic','','',now(),$1,'indexing','','uploaded','','')",['1\n00:00:00,000 --> 00:00:01,000\n標本化とは信号の離散化です。\n']);
      child=spawn(process.execPath,['dist/background-worker.mjs'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{
        DATABASE_URL:url.href,BETTER_AUTH_SECRET:'synthetic-background-secret-at-least-32-bytes',BETTER_AUTH_URL:'http://localhost',USER_SECRET_ENCRYPTION_KEY:Buffer.alloc(32).toString('base64url'),
        R2_ACCESS_KEY_ID:'local',R2_SECRET_ACCESS_KEY:'local',R2_BUCKET_NAME:'unused-test-bucket',R2_S3_ENDPOINT:'http://localhost:9000',
        SQS_QUEUE_URL:`${endpoint}000000000000/unused-media`,SQS_SEARCH_QUEUE_URL:queues[0],SQS_ACCOUNT_QUEUE_URL:queues[1],AWS_REGION:'us-east-1',AWS_ACCESS_KEY_ID:'local',AWS_SECRET_ACCESS_KEY:'local',
        EMBEDDING_PROFILE:'embeddinggemma2',EMBEDDING_MODEL:'private-gemma',EMBEDDING_BASE_URL:`http://127.0.0.1:${address.port}/v1`,EMBEDDING_API_KEY:'test',
      }});
      child.stdout!.on('data',data=>{logs+=String(data);});child.stderr!.on('data',data=>{logs+=String(data);});
      const waitFor=async(check:()=>Promise<boolean>)=>{
        const until=Date.now()+30_000;
        while(Date.now()<until){if(modelError)throw modelError instanceof Error?modelError:new Error('Synthetic model failed');if(await check())return;if(child!.exitCode!==null)throw new Error(`Worker exited: ${logs}`);await delay(100);}
        throw new Error(`Worker did not finish: ${logs}`);
      };
      const indexJob={type:'index_video_transcript',job_id:'node-index',payload:{video_id:1}};
      await request('SendMessage',{QueueUrl:queues[0],MessageBody:JSON.stringify(indexJob)});
      await waitFor(async()=> (await db.query("SELECT status FROM job_executions WHERE job_id='node-index'")).rows[0]?.status==='completed');
      expect((await db.query('SELECT status FROM videos WHERE id=1')).rows[0].status).toBe('completed');
      expect((await db.query('SELECT vector_dims(embedding) AS dimensions FROM scene_embeddings_768 WHERE video_id=1')).rows).toEqual([{dimensions:768}]);
      expect(modelCalls).toBe(1);
      await request('SendMessage',{QueueUrl:queues[0],MessageBody:JSON.stringify(indexJob)});
      await waitFor(async()=>{
        const state=await request('GetQueueAttributes',{QueueUrl:queues[0],AttributeNames:['ApproximateNumberOfMessages','ApproximateNumberOfMessagesNotVisible']});
        return state.Attributes.ApproximateNumberOfMessages==='0'&&state.Attributes.ApproximateNumberOfMessagesNotVisible==='0';
      });
      expect(modelCalls).toBe(1);
      const deletion={type:'delete_account_data',job_id:'node-delete',payload:{user_id:'delete-owner'}};
      await db.query("INSERT INTO external_tasks(kind,payload,dedupe_key) VALUES('sqs_job',$1,'account-delete:delete-owner')",[{message:deletion}]);
      await request('SendMessage',{QueueUrl:queues[1],MessageBody:JSON.stringify(deletion)});
      await waitFor(async()=> (await db.query("SELECT status FROM job_executions WHERE job_id='node-delete'")).rows[0]?.status==='completed');
      expect((await db.query("SELECT id FROM users ORDER BY id")).rows).toEqual([{id:'index-owner'}]);
      expect(logs).not.toContain('background_job_retry');
    }finally{
      if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await Promise.race([exited,delay(5000)]);if(child.exitCode===null)child.kill('SIGKILL');}
      model.close();
      for(const QueueUrl of queues)await request('DeleteQueue',{QueueUrl}).catch(()=>undefined);
      await db.end();await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();
    }
  },90_000);
});
