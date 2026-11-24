import { AwsClient } from 'aws4fetch';
import { BackgroundJobBusyError, parseBackgroundJob, type BackgroundJob } from '../../application/background-job';
import type { Bindings } from '../../types/bindings';
import { runBackgroundJob } from './execute';
import { logJobFailure, receiveAttempts, type JobStage } from './diagnostics';

export class SqsBackgroundConsumer {
  private readonly aws: AwsClient;
  constructor(private readonly env: Bindings, private readonly queueUrl: string, private readonly group: 'account' | 'search') {
    if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw new Error('Queue credentials are missing');
    this.aws = new AwsClient({accessKeyId:env.AWS_ACCESS_KEY_ID,secretAccessKey:env.AWS_SECRET_ACCESS_KEY,sessionToken:env.AWS_SESSION_TOKEN,region:env.AWS_REGION,service:'sqs',retries:0});
  }
  private async request<T>(operation: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const response = await this.aws.fetch(new URL('/', this.queueUrl).href, {
      method:'POST',headers:{'content-type':'application/x-amz-json-1.0','x-amz-target':`AmazonSQS.${operation}`},
      body:JSON.stringify({QueueUrl:this.queueUrl,...body}),
      signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`SQS ${operation} failed (${response.status})`); }
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
  async poll(signal: AbortSignal): Promise<void> {
    const result = await this.request<{Messages?:{MessageId:string;ReceiptHandle:string;Body:string;Attributes?:{ApproximateReceiveCount?:string}}[]}>('ReceiveMessage',{
      MaxNumberOfMessages:1,WaitTimeSeconds:20,VisibilityTimeout:960,MessageSystemAttributeNames:['ApproximateReceiveCount'],
    },signal);
    for (const message of result.Messages ?? []) {
      if(signal.aborted) return;
      const started = performance.now();
      let stage: JobStage = 'decode';
      let job: BackgroundJob | undefined;
      try {
        const input: unknown = JSON.parse(message.Body);
        stage = 'validate';
        job = parseBackgroundJob(input);
        if ((job.type==='delete_account_data'?'account':'search')!==this.group) throw new Error('Wrong background queue group');
        stage = 'execute';
        await runBackgroundJob(this.env,job,AbortSignal.any([signal,AbortSignal.timeout(780_000)]));
        stage = 'ack';
        await this.request('DeleteMessage',{ReceiptHandle:message.ReceiptHandle});
      } catch (error) {
        logJobFailure(error, {event:'background_job_retry',group:this.group,stage,started,
          message_id:message.MessageId,job_id:job?.job_id,job_type:job?.type,attempts:receiveAttempts(message.Attributes?.ApproximateReceiveCount)});
        // The execution repository releases failed work. Do not delete messages
        // after failures, process termination or a lost execution lease.
        await this.request('ChangeMessageVisibility',{ReceiptHandle:message.ReceiptHandle,VisibilityTimeout:error instanceof BackgroundJobBusyError ? 960 : 30}).catch(()=>undefined);
      }
    }
  }
}
