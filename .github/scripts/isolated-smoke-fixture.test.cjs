const {test}=require('node:test'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const {loadReviewedSmokeFixture:load}=require('./isolated-smoke-fixture.cjs');
const {fixtureValid}=require('./production-smoke-policy.cjs');
const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
test('fixture comes from the committed fixed-path Git blob and retains the approved hash',()=>{const bytes=load({source});assert.equal(fixtureValid(bytes),true);assert.equal(bytes.length,43914);});
test('fixture reader has no arbitrary filename, revision expression or inherited credential input',()=>{
 const bytes=load({source});let calls=0;
 assert.equal(load({source,env:{PATH:'fixture',HOME:'fixture',CLOUDFLARE_API_TOKEN:'must-not-forward',AWS_SECRET_ACCESS_KEY:'must-not-forward'},execute:(program,args,options)=>{calls++;assert.equal(program,'git');assert.deepEqual(args,['show',source+':.github/operations-tools/fixtures/smoke.mp4']);assert.equal(options.env.CLOUDFLARE_API_TOKEN,undefined);assert.equal(options.env.AWS_SECRET_ACCESS_KEY,undefined);return bytes;}}).length,bytes.length);assert.equal(calls,1);
 for(const value of ['HEAD','main:../../private','a'.repeat(39)])assert.throws(()=>load({source:value,execute:()=>assert.fail('command ran')}),/FIXTURE_REQUIRED/);
});
test('missing or changed committed fixture fails closed without leaking Git error output',()=>{
 assert.throws(()=>load({source,execute:()=>Buffer.from('not-the-reviewed-mp4')}),/FIXTURE_REQUIRED/);
 assert.throws(()=>load({source,execute:()=>{throw Error('PRIVATE_GIT_BODY');}}),{message:'ISOLATED_SMOKE_FIXTURE_REQUIRED'});
});
