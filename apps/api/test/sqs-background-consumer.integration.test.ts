import { describe,it,expect,vi } from 'vitest';
import { AwsClient } from 'aws4fetch';
import type { Bindings } from '../src/types/bindings';
vi.mock('../src/integrations/background-jobs/execute',()=>({runBackgroundJob:vi.fn(async()=>{})}));
import { runBackgroundJob } from '../src/integrations/background-jobs/execute';
import { SqsBackgroundConsumer } from '../src/integrations/background-jobs/sqs-consumer';
const url=process.env.SQS_TEST_QUEUE_URL;
(url?describe:describe.skip)('Node consumer against actual SQS-compatible JSON protocol',()=>{
  const aws=new AwsClient({accessKeyId:'local',secretAccessKey:'local',region:'us-east-1',service:'sqs',retries:0});
  async function request(operation:string,body:Record<string,unknown>){
    const response=await aws.fetch(new URL('/',url).href,{method:'POST',headers:{'content-type':'application/x-amz-json-1.0','x-amz-target':`AmazonSQS.${operation}`},body:JSON.stringify({QueueUrl:url,...body})});
    expect(response.status).toBe(200);const text=await response.text();return text?JSON.parse(text):{};
  }
  it('receives one job, executes it, and deletes only after success',async()=>{
    const job={type:'reindex_video_transcript',job_id:crypto.randomUUID(),payload:{video_id:1}};
    await request('SendMessage',{MessageBody:JSON.stringify(job)});
    const env={AWS_ACCESS_KEY_ID:'local',AWS_SECRET_ACCESS_KEY:'local',AWS_REGION:'us-east-1'} as Bindings;
    await new SqsBackgroundConsumer(env,url!,'search').poll(AbortSignal.timeout(30_000));
    expect(runBackgroundJob).toHaveBeenCalledWith(env,job,expect.any(AbortSignal));
    const state=await request('GetQueueAttributes',{AttributeNames:['ApproximateNumberOfMessages','ApproximateNumberOfMessagesNotVisible']});
    expect(state.Attributes).toMatchObject({ApproximateNumberOfMessages:'0',ApproximateNumberOfMessagesNotVisible:'0'});
  });
});
