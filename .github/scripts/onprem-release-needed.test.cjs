const {test} = require('node:test');
const assert = require('node:assert/strict');
const decide = require('./onprem-release-needed.cjs');
const A='a'.repeat(40), B='b'.repeat(40), repo={owner:'videoq-jp',repo:'videoq'};
function fixture({files=[],status='ahead',commits=2,releases,runPatch={}}={}) {
  const calls=[];
  const release={id:1,tag_name:`onprem-${A}-42-1`,target_commitish:A,draft:false,prerelease:false,
    published_at:'2026-11-12T00:00:00Z',assets:[{name:'release.json'},{name:'release.sigstore.json'}]};
  const github={rest:{repos:{listReleases(){}},actions:{async getWorkflowRun(p){
    calls.push(['run',p]);return {data:{status:'completed',conclusion:'success',head_branch:'main',
      head_sha:A,run_attempt:1,path:'.github/workflows/onprem-release.yml',
      repository:{full_name:'videoq-jp/videoq'},head_repository:{full_name:'videoq-jp/videoq'},...runPatch}};
  }}},async paginate(method,p){assert.equal(method,github.rest.repos.listReleases);calls.push(['releases',p]);return releases??[release];},
  async request(route,p){assert.equal(route,'GET /repos/{owner}/{repo}/compare/{basehead}');
    assert.equal(p.basehead,`${A}...${B}`);calls.push(['compare',p]);return {data:{status,total_commits:commits,files}};}};
  return {github,context:{repo,eventName:'workflow_run'},sha:B,calls};
}
test('documentation, adopted pins and retention housekeeping retain the existing release',async()=>{
  const f=fixture({files:['README.md','docs/guides/lab-gitops.md','apps/docs/i18n/ja/guide.md',
    '.github/deployment-pins/vast4090.json','.github/scripts/onprem_distribution.py',
    '.github/scripts/test_onprem_distribution.py','.github/workflows/onprem-retention.yml'].map(filename=>({filename}))});
  assert.equal((await decide(f)).needed,false);
  assert.equal(f.calls.filter(c=>c[0]==='compare').length,1);
});
test('runtime, bootstrap, charts and release verification policy changes still publish',async()=>{
  for(const filename of ['apps/api/src/app.ts','apps/web/src/App.tsx','apps/worker/app.py',
    'apps/inference/whisper/provision.py','packages/trpc/src/index.ts','charts/videoq-inference/values.yaml',
    'infra/ansible/roles/lab/tasks/main.yml','scripts/gitops/promote.py','scripts/onprem/public_release.py',
    '.github/workflows/onprem-release.yml','.github/scripts/verify-onprem-artifacts.cjs','package-lock.json','unknown-input']) {
    assert.equal((await decide(fixture({files:[{filename}]}))).needed,true,filename);
  }
});
test('unreleased code is not lost when the newest commit only edits documentation',async()=>{
  const f=fixture({commits:4,files:[{filename:'docs/guides/lab-gitops.md'},{filename:'apps/inference/whisper/provision.py'}]});
  assert.equal((await decide(f)).needed,true);
  assert.equal(f.calls.find(c=>c[0]==='compare')[1].basehead,`${A}...${B}`);
});
test('renaming runtime code into an ignored directory cannot hide its removal',async()=>{
  assert.equal((await decide(fixture({files:[{filename:'docs/old.ts',previous_filename:'apps/api/src/old.ts'}]}))).needed,true);
  assert.equal((await decide(fixture({files:[{filename:'docs/new.md',previous_filename:'docs/old.md'}]}))).needed,false);
  assert.equal((await decide(fixture({files:[{filename:'docs-like/runtime.ts'}]}))).needed,true);
});
test('unverifiable or absent published baselines require a release',async()=>{
  assert.equal((await decide(fixture({releases:[]}))).needed,true);
  for(const runPatch of [{conclusion:'failure'},{head_sha:B},{run_attempt:2},{head_branch:'feature'},
    {path:'.github/workflows/ci.yml'},{repository:{full_name:'other/repo'}},{head_repository:{full_name:'fork/videoq'}}]) {
    assert.equal((await decide(fixture({runPatch}))).needed,true);
  }
});
test('unknown, non-forward and possibly truncated comparisons never skip a release',async()=>{
  for(const status of ['behind','diverged','unknown']) assert.equal((await decide(fixture({status}))).needed,true);
  assert.equal((await decide(fixture({files:Array.from({length:100},(_,n)=>({filename:`docs/${n}.md`}))}))).needed,true);
  for(const commits of [0,101,undefined,1.5]) {
    const f=fixture();f.github.request=async()=>({data:{status:'ahead',files:[],total_commits:commits}});
    assert.equal((await decide(f)).needed,true);
  }
  const f=fixture();f.github.request=async()=>({data:{status:'ahead',total_commits:1}});
  assert.equal((await decide(f)).needed,true);
});
test('manual requests force a release, while an already released automatic source does not rebuild',async()=>{
  const f=fixture();f.context.eventName='workflow_dispatch';
  assert.equal((await decide(f)).needed,true);assert.deepEqual(f.calls,[]);
  const same=fixture();same.sha=A;
  assert.equal((await decide(same)).needed,false);
  assert.equal(same.calls.filter(c=>c[0]==='compare').length,0);
});
test('API failures do not silently turn a release into a skipped run',async()=>{
  const f=fixture();f.github.request=async()=>{throw new Error('API unavailable');};
  await assert.rejects(decide(f),/API unavailable/);
});
test('invalid repository, source or event is rejected before API use',async()=>{
  for(const patch of [{sha:'main'},{context:{repo:{owner:'other',repo:'videoq'},eventName:'workflow_run'}},
    {context:{repo,eventName:'pull_request'}}]) {
    const f=fixture();Object.assign(f,patch);await assert.rejects(decide(f));assert.deepEqual(f.calls,[]);
  }
});
