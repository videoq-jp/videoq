import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { nodeBindings, integerSetting } from './node-config';
import { SqsBackgroundConsumer } from '../integrations/background-jobs/sqs-consumer';

const env=nodeBindings(process.env);
const groups=(process.env.BACKGROUND_WORKER_GROUPS || 'account,search').split(',');
if(groups.some(g=>g!=='account'&&g!=='search') || new Set(groups).size!==groups.length)throw new Error('Invalid background worker groups');
const urls=groups.map(group=>group==='account'?env.SQS_ACCOUNT_QUEUE_URL:env.SQS_SEARCH_QUEUE_URL);
if(urls.some(url=>!url)||new Set(urls).size!==urls.length||urls.includes(env.SQS_MEDIA_QUEUE_URL || env.SQS_QUEUE_URL)){
  throw new Error('Background workers require dedicated search/account queues distinct from the media queue');
}
const pool=new pg.Pool({connectionString:env.DATABASE_URL,max:integerSetting(process.env,'BACKGROUND_DATABASE_POOL_MAX',4,2,20),statement_timeout:60_000});
pool.on('error',()=>console.error(JSON.stringify({event:'background_database_pool_error'})));
env.DATABASE_POOL=pool;
const shutdown=new AbortController();
process.once('SIGINT',()=>shutdown.abort());
process.once('SIGTERM',()=>shutdown.abort());
try {
  await Promise.all(groups.map(async(group,index)=>{
    const consumer=new SqsBackgroundConsumer(env,urls[index]!,group as 'account'|'search');
    while(!shutdown.signal.aborted){
      try { await consumer.poll(shutdown.signal); }
      catch {
        if(shutdown.signal.aborted)break;
        console.error(JSON.stringify({event:'background_queue_poll_failed',group}));
        await delay(3000,undefined,{signal:shutdown.signal}).catch(()=>undefined);
      }
    }
  }));
} finally { await pool.end(); }
