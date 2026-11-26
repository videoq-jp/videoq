const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {spawnSync}=require('node:child_process');
const vm=require('node:vm');
const ci=readFileSync('.github/workflows/ci.yml','utf8');
const publisher=readFileSync('.github/workflows/whisper-candidate-publish.yml','utf8');
const tag='refs/tags/videoq-whisper-candidate-publisher-20261125-v1';
function job(text,name){return text.split(`\n  ${name}:\n`)[1].split(/\n  [a-z][a-z-]*:\n/)[0];}
function condition(name,context){let expression=job(ci,name).match(/^    if: (.+)$/m)[1].replace(/^\$\{\{\s*|\s*\}\}$/g,'');return vm.runInNewContext(expression,{github:context,inputs:{mode:context.mode},always:()=>true});}
test('isolated mode cannot skip required PR, push, merge-group or normal dispatch checks',()=>{
 for(const event of ['pull_request','push','merge_group','workflow_dispatch'])for(const mode of ['', 'normal','whisper-candidate-publish'])for(const ref of ['refs/heads/main','refs/pull/1685/merge',tag]){
  const context={repository:'videoq-jp/videoq',event_name:event,ref,mode};
  const isolated=event==='workflow_dispatch'&&mode==='whisper-candidate-publish'&&ref===tag;
  for(const name of ['supply-chain','workflow-security','delivery-regression','changes','ci-success','container-result','terraform-result'])assert.equal(condition(name,context),!isolated,`${name}/${event}/${mode}/${ref}`);
 }
});
test('actual dispatch guard rejects wrong ref/repository/revision before calling publisher',()=>{
 const script=job(ci,'whisper-candidate-dispatch').split('        run: |\n')[1].split('\n').map(line=>line.replace(/^          /,'')).join('\n');
 const initial={...process.env,GITHUB_REPOSITORY:'videoq-jp/videoq',GITHUB_REF:tag,REVIEWED_REVISION:'a'.repeat(40),GITHUB_SHA:'a'.repeat(40),WORKFLOW_SHA:'a'.repeat(40)};
 assert.equal(spawnSync('bash',['-eu','-c',script],{env:initial}).status,0);
 for(const [key,value] of [['GITHUB_REPOSITORY','other/repo'],['GITHUB_REF','refs/heads/main'],['REVIEWED_REVISION',''],['WORKFLOW_SHA','b'.repeat(40)],['GITHUB_SHA','b'.repeat(40)]])assert.notEqual(spawnSync('bash',['-eu','-c',script],{env:{...initial,[key]:value}}).status,0,key);
});
test('privileged publisher executes pinned trusted tooling and only copies fixed approved OCI data',()=>{
 const writer=job(publisher,'publish');
 assert.match(writer,/needs: \[source, validate\]/);
 assert.match(writer,/ref: ae96bf7ea3db11be1aeb68963e0f9b32265bd428/);
 assert.match(writer,/sparse-checkout: \.github\/scripts/);
 assert.doesNotMatch(writer,/docker (?:build|run|load)|npm |pip |secrets\.|secrets: inherit|pull_request_target/);
 assert.match(writer,/oras cp --from-oci-layout/);
 assert.match(writer,/repository=ghcr\.io\/videoq-jp\/videoq-whispercpp-candidate/);
 assert.ok(writer.indexOf('whisper-candidate-publication.py --directory')<writer.indexOf('oras login'));
 assert.doesNotMatch(publisher,/pull_request_target|workflow_run:/);
 for(const name of ['source','validate'])assert.doesNotMatch(job(publisher,name),/packages: write/);
 const readback=job(publisher,'independent-readback');
 assert.match(readback,/anonymous-docker/);assert.match(readback,/source: registry:ghcr.io\/videoq-jp\/videoq-whispercpp-candidate@/);
 assert.doesNotMatch(readback,/packages: write|oras login|security-config:/);
});
