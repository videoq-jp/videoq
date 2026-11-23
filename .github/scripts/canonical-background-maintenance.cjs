const {resourceDigest}=require('./d1-resource-journal.cjs');
const {createBackgroundMaintenanceStore}=require('./background-maintenance-store.cjs');
const {createBackgroundMaintenanceTransport}=require('./background-maintenance-transport.cjs');
const {createBackgroundMaintenance}=require('./background-maintenance.cjs');
function createCanonicalBackgroundMaintenance({aws,run,source,credential,store,fetcher,assertOwnership,assertApiPaused,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 if(credential?.CLOUDFLARE_ACCOUNT_ID!=='12daec56fdba43f677f2766ee26a5a39')throw Error('BACKGROUND_MAINTENANCE_ACCOUNT_REQUIRED');
 const plans=store??createBackgroundMaintenanceStore({aws,run,source,assertOwnership});
 const request=createBackgroundMaintenanceTransport({token:credential.CLOUDFLARE_API_TOKEN,fetcher});
 const proof={version:1,source,run,schemaCommandCompleted:true};
 async function completed(){
  const saved=await plans.load('background-schema-complete');
  if(saved===null)return false;
  if(resourceDigest(saved)!==resourceDigest(proof))throw Error('BACKGROUND_MAINTENANCE_SCHEMA_PROOF_INVALID');return true;
 }
 const control=createBackgroundMaintenance({request,plans,assertOwnership,assertApiPaused,now,assertRestoreSafe:async()=>{
  await assertOwnership();await assertApiPaused();if(!await completed())throw Error('BACKGROUND_MAINTENANCE_SCHEMA_PROOF_REQUIRED');
 }});
 return{
  request,completed,
  async pause(){
   const started=now();
   for(;;){
    const state=await control.pause();if(state.status==='paused')return;
    if(now()-started>=25*60*1000)throw Error('BACKGROUND_MAINTENANCE_PAUSE_PENDING');
    await sleep(Math.min(state.retryAfterMs??5000,5000));
   }
  },
  async markComplete(){await assertOwnership();await assertApiPaused();await plans.save('background-schema-complete',proof);},
  async restore(){if(!await completed())throw Error('BACKGROUND_MAINTENANCE_SCHEMA_PROOF_REQUIRED');return control.restore();},
 };
}
// Verification closes native producers through verified SQS routing rather than
// pausing the API. Its proof cannot authorize a schema command.
async function verifyBackgroundMaintenance({aws,run,source,credential,fetcher,assertOwnership,assertProducerAdmissionClosed,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 if(credential?.CLOUDFLARE_ACCOUNT_ID!=='12daec56fdba43f677f2766ee26a5a39')throw Error('BACKGROUND_MAINTENANCE_ACCOUNT_REQUIRED');
 const plans=createBackgroundMaintenanceStore({aws,run,source,assertOwnership,verificationOnly:true});
 const request=createBackgroundMaintenanceTransport({token:credential.CLOUDFLARE_API_TOKEN,fetcher});
 const proof={version:1,run,source,verificationOnly:true};
 const guard=async()=>{await assertOwnership();await assertProducerAdmissionClosed();};
 const paused=async()=>{
  const saved=await plans.load('background-verification-paused');
  if(saved===null)return false;
  if(resourceDigest(saved)!==resourceDigest(proof))throw Error('BACKGROUND_VERIFICATION_PROOF_INVALID');return true;
 };
 const control=createBackgroundMaintenance({request,plans,assertOwnership,assertProducerAdmissionClosed:guard,now,assertRestoreSafe:async()=>{
  await guard();if(!await paused())throw Error('BACKGROUND_VERIFICATION_PAUSE_PROOF_REQUIRED');
 }});
 await guard();
 if(!await paused()){
  const started=now();
  for(;;){
   const state=await control.pause();if(state.status==='paused')break;
   if(now()-started>=25*60*1000)throw Error('BACKGROUND_VERIFICATION_PAUSE_PENDING');
   await sleep(Math.min(state.retryAfterMs??5000,5000));
  }
  await guard();await plans.save('background-verification-paused',proof);
  // Deliberately fail once only after a durable pause checkpoint. The same
  // execution's native redrive must restore these exact original plans.
  throw Error('BACKGROUND_VERIFICATION_RECOVERY_REQUIRED');
 }
 const result=await control.restore();await guard();
 await plans.save('background-verification-complete',proof);
 return{...result,verificationOnly:true};
}
module.exports={createCanonicalBackgroundMaintenance,verifyBackgroundMaintenance};
