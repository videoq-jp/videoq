import {createD1Fixture} from './d1-fixture';
import {seedPrivacyFixture} from './contracts/privacy-seed';
import type {Bindings} from '../../src/types/bindings';
export {privacyFixtureInstallation} from './contracts/privacy-seed';
export async function createD1PrivacyFixture(){
 const f=await createD1Fixture(),execute=async(sql:string,args:unknown[]=[])=>{await f.database.prepare(sql).bind(...args).run();};
 try{
  const env={DB:f.database,DEPLOYMENT_EDITION:'cloud'} as Bindings;
  const seeded=await seedPrivacyFixture(env,execute,async(thread,label)=>{
  const bytes=(text:string)=>new TextEncoder().encode(text).buffer;
  await execute("INSERT INTO conversation_checkpoints(thread_id,namespace,checkpoint_id,checkpoint_type,checkpoint,metadata_type,metadata) VALUES(?,'','checkpoint','json',?,'json',?)",[thread,bytes(`${label}-private-model-memory`),bytes(`${label}-private-metadata`)]);
  await execute("INSERT INTO conversation_checkpoint_writes(thread_id,namespace,checkpoint_id,task_id,idx,channel,value_type,value) VALUES(?,'','checkpoint','task',0,'messages','json',?)",[thread,bytes(`${label}-private-pending-write`)]);
  });
  return {...f,env,execute,...seeded};
 }catch(error){await f.dispose();throw error;}
}
