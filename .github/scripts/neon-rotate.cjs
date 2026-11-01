// Runs only in the main-only production-db-maintenance Environment, serialized with migrations.
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { prepare, promote, retire, complete, rollback, finishRollback, completeRollback, readParameter, JOURNAL } = require('./neon-admin.cjs');
function gh(method, path, input) {
  try {
    const args=['api','--method',method,path];
    if(input) args.push('--input','-');
    const value=execFileSync('gh',args,{input:input?JSON.stringify(input):undefined,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:60000});
    return value?JSON.parse(value):null;
  } catch {throw new Error('GITHUB_VERIFICATION_API_FAILED');}
}
async function verification(workflow, inputs, expectedName) {
  const repo='repos/videoq-jp/videoq';
  const since=new Date(Date.now()-1000).toISOString();
  gh('POST',`${repo}/actions/workflows/${workflow}/dispatches`,{ref:'main',inputs});
  for(let attempt=0;attempt<160;attempt++) {
    const result=gh('GET',`${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=30&created=%3E%3D${encodeURIComponent(since)}`);
    const matches=result.workflow_runs.filter(run=>run.display_title===expectedName&&run.head_sha===process.env.GITHUB_SHA&&run.head_branch==='main');
    if(matches.length>1) throw new Error('AMBIGUOUS_ROTATION_VERIFICATION');
    if(matches[0]?.status==='completed') {
      if(matches[0].conclusion!=='success') throw new Error('ROTATION_PRODUCTION_VERIFICATION_FAILED');
      console.log('Verified '+expectedName+' run '+matches[0].id);return matches[0].id;
    }
    await delay(15000);
  }
  throw new Error('ROTATION_VERIFICATION_TIMEOUT');
}
async function smoke(generation) {
  return verification('operations.yml',{check:'smoke',verify_ai_answers:'false',db_rotation_id:generation},`Operations smoke ${generation}`);
}
async function main() {
  if(process.env.GITHUB_REPOSITORY!=='videoq-jp/videoq'||process.env.GITHUB_REF!=='refs/heads/main') throw new Error('PRODUCTION_MAIN_ONLY');
  const operation=process.env.OPERATION||'rotate';
  if(!['rotate','rollback'].includes(operation)) throw new Error('UNKNOWN_ROTATION_OPERATION');
  const pending=readParameter(JOURNAL,true);
  if(operation==='rollback'||['rollback_pending','rollback_retired'].includes(pending?.phase)) {
    const recovery=await rollback(pending);
    if(recovery.phase==='rollback_pending') {
      await smoke(recovery.generation+'-rollback');
      while(Date.now()<Date.parse(recovery.rollback_after)) await delay(Math.min(30000,Date.parse(recovery.rollback_after)-Date.now()));
      await finishRollback(recovery);
    }
    await smoke(recovery.generation+'-rollback-retired');
    completeRollback(recovery);
    console.log('Previous credentials restored and abandoned candidate logins disabled');
    return;
  }
  let journal=await prepare(process.env.FORCE_ROTATION==='true');
  if(!journal) return;
  if(journal.phase==='prepared') journal=await promote(journal);
  if(!['promoted','retired'].includes(journal.phase)) throw new Error('UNEXPECTED_ROTATION_PHASE');
  if(journal.phase==='promoted') {
  await smoke(journal.generation);
  await verification('operations.yml',{check:'backup',db_rotation_id:journal.generation},`Operations backup ${journal.generation}`);
  await verification('public-demo-setup.yml',{operation:'audit',db_rotation_id:journal.generation},`Public demo audit ${journal.generation}`);
  const remaining=Date.parse(journal.retire_after)-Date.now();
  if(remaining>0) {
    console.log('Waiting for pre-rotation Lambda invocations to finish before retiring old credentials');
    while(Date.now()<Date.parse(journal.retire_after)) await delay(Math.min(30000,Date.parse(journal.retire_after)-Date.now()));
  }
  await retire(journal);
  }
  await smoke(journal.generation+'-retired');
  complete(journal);
  console.log('Database credential rotation and post-retirement production verification succeeded');
}
if(require.main===module) main().catch(error=>{
  // Keep the encrypted journal for safe resume/rollback. Never emit SDK/SQL/HTTP error bodies.
  console.error('Database rotation stopped: '+(/^[A-Z_]+$/.test(error.message)?error.message:error.code||error.name));
  process.exitCode=1;
});
module.exports={verification,gh};
