const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {equivalentVersion,stateResources,main}=require('./reconcile-api-release.cjs');
const old='c91363d0-c948-4099-a42c-192ac8b91714',active='4e07111e-57ca-4f49-a5e4-dd4e5fd2efdf',deployment='380f9193-7567-4357-a227-aed82984f168';
const version=()=>({annotations:{'workers/tag':'reviewed-source'},resources:{script:{etag:'same-code'},script_runtime:{migration_tag:'v5'},bindings:[{name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'running'},{name:'DB',type:'d1',id:'same-database'}]}});
function state(vid=old,did='previous-deployment',serial=7){return{lineage:'retained-lineage',serial,resources:[{module:'module.release',type:'cloudflare_worker_version',name:'release',instances:[{attributes:{id:vid,worker_id:'3dcc0f4ac330413d970b5da7eadec8ea'}}]},{module:'module.release',type:'cloudflare_workers_deployment',name:'active',instances:[{attributes:{id:did,script_name:'videoq-api',versions:[{version_id:vid,percentage:100}]}}]}]};}
function harness({drift=false,concurrent=false,importFailure=false}={}){
 let remote=state(),pulls=0,pushed=null,archived=false;const commands=[];
 const run=(_,args)=>{const dir=args[1].slice(7),cmd=args.slice(2);commands.push({dir,cmd});const isRemote=dir.endsWith('infra/cloudflare-releases/api');
  if(cmd[0]==='state'&&cmd[1]==='pull'){
   if(isRemote){pulls++;if(concurrent&&pulls===2)remote.serial++;return{status:0,stdout:JSON.stringify(remote)};}
   return{status:0,stdout:JSON.stringify(state(active,deployment,10))};
  }
  if(cmd[0]==='import'&&importFailure)return{status:1,stdout:''};
  if(cmd[0]==='state'&&cmd[1]==='push'){assert.equal(archived,true);pushed=JSON.parse(fs.readFileSync(cmd[2]));remote=pushed;}
  return{status:0,stdout:''};
 };
 const fetcher=async url=>{let result;if(url.endsWith('/deployments'))result={deployments:[{id:deployment,versions:[{version_id:active,percentage:100}]}]};else{result=version();if(drift&&url.endsWith(active))result.resources.script.etag='changed';}return Response.json({success:true,result});};
 return{execute:()=>main({env:{EXPECTED_STATE_VERSION:old,EXPECTED_ACTIVE_VERSION:active,EXPECTED_ACTIVE_DEPLOYMENT:deployment},run,fetcher,archive:async text=>{assert.equal(JSON.parse(text).serial,7);archived=true;}}),commands,get pushed(){return pushed;}};
}
test('equivalent metadata versions can be adopted, reordered bindings are harmless',()=>{const after=version();after.resources.bindings.reverse();equivalentVersion(version(),after);});
test('code, runtime, bindings, pause state and source annotation drift fail closed',()=>{
 for(const mutate of [v=>v.resources.script.etag='other',v=>v.resources.script_runtime.migration_tag='other',v=>v.resources.bindings[1].id='other',v=>v.resources.bindings[0].text='paused',v=>v.annotations['workers/tag']='other']){const after=version();mutate(after);assert.throws(()=>equivalentVersion(version(),after),/RECONCILE_/);}
});
test('unexpected or deposed state is never discarded',()=>{const s=state();s.resources.push({});assert.throws(()=>stateResources(s),/UNEXPECTED_STATE/);const t=state();t.resources[0].instances[0].deposed='old';assert.throws(()=>stateResources(t),/UNEXPECTED_STATE/);});
test('imports are local; only verified whole state is pushed after archival',async()=>{const h=harness();await h.execute();assert.equal(h.pushed.lineage,'retained-lineage');assert.equal(h.pushed.serial,8);assert.equal(stateResources(h.pushed).version.id,active);for(const c of h.commands.filter(c=>c.cmd[0]==='import'||c.cmd[1]==='rm'))assert.ok(!c.dir.endsWith('infra/cloudflare-releases/api'));assert.ok(!h.commands.some(c=>c.cmd.includes('apply')||c.cmd.includes('-force')));});
test('code drift, failed local import or concurrent remote state change never push state',async()=>{for(const options of [{drift:true},{importFailure:true},{concurrent:true}]){const h=harness(options);await assert.rejects(h.execute(),/RECONCILE_/);assert.equal(h.pushed,null);}});
