const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const publish = require('./publish-onprem-release.cjs');
const SHA = 'a'.repeat(40);
function fixture() {
  const directory=mkdtempSync(join(tmpdir(),'videoq-public-test-'));
  const components=['api','worker','web','transcription-gateway'];
  writeFileSync(join(directory,'release.json'),JSON.stringify({schemaVersion:5,repository:'videoq-jp/videoq',sourceSha:SHA,images:Object.fromEntries(components.map(c=>[c,{}]))}));
  for(const name of [`videoq-0.1.0-sha.${SHA}.tgz`,`videoq-inference-0.1.0-sha.${SHA}.tgz`,'release.sigstore.json',...components.map(c=>c+'.sigstore.json')]) writeFileSync(join(directory,name),'fixture');
  const calls=[];
  const repos={getReleaseByTag:async()=>{const error=new Error('missing');error.status=404;throw error},createRelease:async p=>{calls.push(['create',p]);return {data:{id:1}}},uploadReleaseAsset:async p=>{calls.push(['upload',p])},updateRelease:async p=>{calls.push(['publish',p]);return{data:{html_url:'https://example.test/release'}}}};
  return {directory,calls,repos,args:{github:{rest:{repos}},context:{repo:{owner:'videoq-jp',repo:'videoq'},ref:'refs/heads/main',eventName:'workflow_run',sha:SHA},sourceSha:SHA,runId:123,attempt:2,directory}};
}
test('public release stays draft until every static signed input is uploaded',async()=>{
 const f=fixture();try{await publish(f.args);assert.equal(f.calls[0][1].draft,true);assert.equal(f.calls.filter(c=>c[0]==='upload').length,8);assert.equal(f.calls.at(-1)[0],'publish');assert.equal(f.calls.at(-1)[1].draft,false);assert.equal(f.calls[0][1].target_commitish,SHA)}finally{rmSync(f.directory,{recursive:true,force:true})}
});
test('a published tag is immutable and untrusted contexts cannot publish',async()=>{
 const f=fixture();try{f.repos.getReleaseByTag=async()=>({data:{id:1}});await assert.rejects(publish(f.args),/already exists/);assert.equal(f.calls.length,0);await assert.rejects(publish({...f.args,context:{...f.args.context,ref:'refs/pull/1/merge'}}),/validated main/)}finally{rmSync(f.directory,{recursive:true,force:true})}
});
test('missing bundle or failed upload cannot publish a release',async()=>{
 const f=fixture();try{rmSync(join(f.directory,'release.sigstore.json'));await assert.rejects(publish(f.args));assert.equal(f.calls.length,0);writeFileSync(join(f.directory,'release.sigstore.json'),'fixture');f.repos.uploadReleaseAsset=async()=>{throw new Error('offline')};await assert.rejects(publish(f.args),/offline/);assert.equal(f.calls.filter(c=>c[0]==='publish').length,0)}finally{rmSync(f.directory,{recursive:true,force:true})}
});
test('anonymous publication is downstream of both signed and real-model rehearsal gates',()=>{
 const workflow=readFileSync(join(__dirname,'../workflows/onprem-release.yml'),'utf8');
 const job=workflow.split('  public-distribution:\n')[1];
 assert.match(job,/needs: \[source, release, staging, cpu-acceptance\]/);
 assert.match(job,/contents: write/);assert.doesNotMatch(job,/id-token: write|packages: write|secrets\.|pip install|docker (build|run)/);
 assert.match(workflow,/steps\.index-provenance\.outputs\.bundle-path/);
 assert.match(workflow,/steps\.release-provenance\.outputs\.bundle-path/);
 assert.match(workflow,/env -u GH_TOKEN -u GITHUB_TOKEN.*onprem_public.py/);
});
