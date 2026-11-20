// Follow an already completed binding promotion; never initiate one from CD.
// The existing independent state check runs again immediately before upload.
const fs=require('node:fs');
const {assertDeploymentPreservesState,readDeploymentSettings}=require('./protect-api-deployment.cjs');
const ACCOUNT='12daec56fdba43f677f2766ee26a5a39';
const SOURCE=['e57d0931-18cb-4f00-ae7f-b0068030fb04','videoq-scenes-migration-v3-1536','videoq-scenes-migration-v3-768'];
const TARGET=['587bd210-6d9d-4f32-abb7-a490013e65d3','videoq-prod-scenes-1536','videoq-prod-scenes-768'];
const NAMES=['SCENE_VECTORIZE_1536','SCENE_VECTORIZE_768'];
const WORKERS_AI_TARGET=[TARGET[0],TARGET[1],'videoq-prod-scenes-embeddinggemma2-768'];
const same=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
function deploymentHandoff(settings,config){
 if(config?.name!=='videoq-api'||config.vars?.DEPLOYMENT_EDITION!=='cloud'||config.vars?.PERSISTENCE_BACKEND!=='d1'||!Array.isArray(settings?.bindings)||new Set(settings.bindings.map(v=>v.name)).size!==settings.bindings.length)throw Error('RESOURCE_DEPLOYMENT_HANDOFF_REQUIRED');
 const one=(rows,key,name)=>{if(!Array.isArray(rows))throw Error('RESOURCE_DEPLOYMENT_HANDOFF_REQUIRED');const matches=rows.filter(v=>v[key]===name);if(matches.length!==1)throw Error('RESOURCE_DEPLOYMENT_HANDOFF_REQUIRED');return matches[0];};
 for(const [name,text] of [['DEPLOYMENT_EDITION','cloud'],['PERSISTENCE_BACKEND','d1']]){const row=one(settings.bindings,'name',name);if(row.type!=='plain_text'||row.text!==text)throw Error('RESOURCE_DEPLOYMENT_HANDOFF_REQUIRED');}
 const db=one(settings.bindings,'name','DB'),configuredDb=one(config.d1_databases,'binding','DB');
 if(db.type!=='d1'||db.database_id!==undefined&&db.database_id!==db.id)throw Error('RESOURCE_DEPLOYMENT_HANDOFF_REQUIRED');
 // The 768 index was retired after the completed naming promotion. Only
 // accept its absence when both sides already use the exact production target.
 if(!settings.bindings.some(v=>v.name===NAMES[1])&&Array.isArray(config.vectorize)&&!config.vectorize.some(v=>v.binding===NAMES[1])){
  const liveIndex=one(settings.bindings,'name',NAMES[0]),configuredIndex=one(config.vectorize,'binding',NAMES[0]);
  if(db.id!==TARGET[0]||configuredDb.database_id!==TARGET[0]||configuredDb.database_name!=='videoq-prod-db'||liveIndex.type!=='vectorize'||liveIndex.index_name!==TARGET[1]||configuredIndex.index_name!==TARGET[1])throw Error('RESOURCE_DEPLOYMENT_HANDOFF_REQUIRED');
  assertDeploymentPreservesState(settings,config);
  return structuredClone(config);
 }
 const live=[db.id,...NAMES.map(name=>{const row=one(settings.bindings,'name',name);if(row.type!=='vectorize')throw Error('RESOURCE_DEPLOYMENT_HANDOFF_REQUIRED');return row.index_name;})];
 const configured=[configuredDb.database_id,...NAMES.map(name=>one(config.vectorize,'binding',name).index_name)];
 // Follow only the explicitly approved additive Workers AI preparation. Both
 // live and configured tuples must already match; CD cannot initiate a switch.
 if(same(configured,WORKERS_AI_TARGET)&&same(live,WORKERS_AI_TARGET)&&configuredDb.database_name==='videoq-prod-db'){
  assertDeploymentPreservesState(settings,config);
  return structuredClone(config);
 }
 const isSource=same(configured,SOURCE),isTarget=same(configured,TARGET);
 if(!isSource&&!isTarget||!same(live,SOURCE)&&!same(live,TARGET)||isTarget&&!same(live,TARGET)||configuredDb.database_name!==(isSource?'videoq-d1-migration-staging-v4':'videoq-prod-db'))throw Error('RESOURCE_DEPLOYMENT_HANDOFF_REQUIRED');
 const result=structuredClone(config);
 if(isSource&&same(live,TARGET)){
  const replacement=result.d1_databases.find(v=>v.binding==='DB');replacement.database_id=TARGET[0];replacement.database_name='videoq-prod-db';
  for(const [i,name] of NAMES.entries())result.vectorize.find(v=>v.binding===name).index_name=TARGET[i+1];
 }
 // Also refuses paused service reopen, backend changes, and malformed vars.
 assertDeploymentPreservesState(settings,result);
 return result;
}
async function prepare(config,env=process.env,fetcher=fetch){
 if(env.CLOUDFLARE_ACCOUNT_ID!==ACCOUNT)throw Error('RESOURCE_DEPLOYMENT_ACCOUNT_REQUIRED');
 return deploymentHandoff(await readDeploymentSettings(env,fetcher),config);
}
module.exports={deploymentHandoff,prepare};
if(require.main===module)Promise.resolve().then(async()=>{
 const args=process.argv.slice(2);if(args.length!==1)throw Error('RESOURCE_DEPLOYMENT_ARGUMENTS_REQUIRED');
 const result=await prepare(JSON.parse(fs.readFileSync(args[0],'utf8')));
 fs.writeFileSync(args[0],JSON.stringify(result,null,2));
 console.log(JSON.stringify({deploymentConfigPreservesLiveResources:true}));
}).catch(()=>{console.error('API config handoff refused: preserve the reviewed configuration and verify the live resource tuple.');process.exitCode=1;});
