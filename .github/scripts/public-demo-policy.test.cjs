const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {OWNER,ANSWERS,SLUG,verifyOwner,verifyCourse}=require('./public-demo-policy.cjs');
test('only the dedicated user with the approved 100-answer ceiling is eligible',()=>{
 assert.equal(ANSWERS,100);
 const owner={id:'demo-owner',...OWNER,is_over_quota:false};
 assert.doesNotThrow(()=>verifyOwner(owner));
 for(const field of Object.keys(OWNER)) assert.throws(()=>verifyOwner({...owner,[field]:'someone-else'}));
 assert.throws(()=>verifyOwner({...owner,is_over_quota:true}));
 const description='['+SLUG+'] Original course';
 assert.doesNotThrow(()=>verifyCourse({user_id:owner.id,description},owner,description));
 assert.throws(()=>verifyCourse({user_id:'another-owner',description},owner,description));
 assert.throws(()=>verifyCourse({user_id:owner.id,description:'Other material'},owner,description));
 assert.throws(()=>verifyCourse({user_id:owner.id,description},undefined,description));
});
test('registration cannot send its cookie to storage or use another API/domain',async()=>{
 const original=globalThis.fetch,calls=[];
 globalThis.fetch=async(...args)=>{calls.push(args);return new Response('');};
 try {
  await import('./public-demo-fetch-guard.mjs');
  await fetch('https://videoq.jp/api/trpc/videos.list',{headers:{Cookie:'PRIVATE'}});
  assert.equal(calls[0][1].redirect,'error');
  for(const url of ['https://evil.example/api/trpc/videos.list','https://videoq.jp/api/trpc/admin.users']) assert.throws(()=>fetch(url));
  const upload='https://12daec56fdba43f677f2766ee26a5a39.r2.cloudflarestorage.com/videoq-media-prod/fixture';
  assert.throws(()=>fetch(upload,{method:'PUT',headers:{Cookie:'PRIVATE'}}));
  assert.throws(()=>fetch(upload,{method:'PUT',headers:{Authorization:'PRIVATE'}}));
  await fetch(upload,{method:'PUT'});
  assert.equal(calls.length,2);
 } finally {globalThis.fetch=original;}
});
test('only reviewed main can execute the gated operator after installing isolated tools',()=>{
 const workflow=readFileSync('.github/workflows/public-demo-setup.yml','utf8');
 const source=readFileSync('.github/scripts/provision-public-demo.mjs','utf8');
 assert.match(workflow,/default: audit/);
 assert.match(workflow,/github.ref == 'refs\/heads\/main'/);
 assert.match(workflow,/production-db-demo/);
 assert.match(workflow,/production-db-audit/);
 assert.ok(workflow.indexOf('setup-operations-tools')<workflow.indexOf('uses: ./.github/actions/neon-credentials'));
 assert.ok(workflow.indexOf('uses: ./.github/actions/neon-credentials')<workflow.indexOf('with-neon-credentials.py'));
 assert.doesNotMatch(workflow,/secrets\.DATABASE_URL/);
 assert.doesNotMatch(workflow,/upload-artifact|schedule:|pull_request_target/);
 assert.match(source,/Usage counters are deliberately preserved/);
 assert.doesNotMatch(source,/UPDATE users SET used_ai_answers|INSERT INTO (scene_embeddings|scenes)/);
 assert.match(source,/child\.stdout\.resume\(\); child\.stderr\.resume\(\)/);
});
