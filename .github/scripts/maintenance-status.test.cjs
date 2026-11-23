const test=require('node:test'),assert=require('node:assert/strict');
const {maintenanceStatus}=require('./maintenance-status.cjs');
const {readFileSync}=require('node:fs'),{join}=require('node:path');
const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'videoq-jp/videoq',GITHUB_REF:'refs/heads/main',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:'a'.repeat(40),GITHUB_WORKFLOW_SHA:'a'.repeat(40),ACTIONS_ID_TOKEN_REQUEST_URL:'https://pipelines.actions.githubusercontent.com/token',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic-oidc',GH_MAINTENANCE_READ_TOKEN:'synthetic-github-read-token'};
test('status reads use the fixed read-only route without acquiring or sending runtime credentials',async()=>{
 let requests=0;const fetcher=async(url,options)=>{
  if(String(url).includes('pipelines.actions'))return Response.json({value:'signed-fixture-token'});
  requests++;assert.equal(url,'https://videoq-maintenance-prod.yukiharada1228.workers.dev/v1/status/migration');assert.deepEqual(JSON.parse(options.body),{action:'status'});assert.equal(options.body.includes('synthetic-github'),false);return Response.json({owner:null});
 };
 assert.deepEqual(await maintenanceStatus({kind:'migration',env,fetcher}),{kind:'migration',owner:null});assert.equal(requests,1);
});
test('inspection workflow has no runtime secret or installation step and uses both protected purpose environments',()=>{
 const source=readFileSync(join(__dirname,'../workflows/maintenance-status.yml'),'utf8');assert.equal(source.includes('secrets.'),false);assert.equal(source.includes('npm '),false);assert.match(source,/production-db-migration/);assert.match(source,/production-db-smoke/);assert.match(source,/id-token: write/);assert.match(source,/github.ref == 'refs\/heads\/main'/);
});
test('manual migration verification fixes read-only admission and grants no background credentials',()=>{
 const source=readFileSync(join(__dirname,'../workflows/database-migrate.yml'),'utf8');assert.match(source,/vars.CLOUDFLARE_MAINTENANCE_ENABLED == 'true'/);assert.match(source,/environment: production-db-migration/);assert.match(source,/github.ref == 'refs\/heads\/main'/);assert.equal((source.match(/secrets\./g)??[]).length,1);assert.match(source,/STRUCTURED_ANSWER_WRITERS_STOPPED: "0"/);assert.equal(source.includes('vars.STRUCTURED_ANSWER_WRITERS_STOPPED'),false);assert.equal(source.includes('CLOUDFLARE_BACKGROUND_TOKEN'),false);assert.match(source,/exercise_recovery && github.run_attempt == 1/);assert.match(source,/!inputs.exercise_recovery \|\| github.run_attempt != 1/);
 const first=source.slice(source.indexOf('- name: Exercise'),source.indexOf('- name: Verify the already'));assert.equal(first.includes('secrets.'),false);
});
test('a missing or malformed owner response is never treated as an idle maintenance coordinator',async()=>{
 for(const response of [{},[],{owner:false},{owner:null,unexpected:true},{owner:{run:'x',state:'released'}}]){
  const fetcher=async url=>String(url).includes('pipelines.actions')?Response.json({value:'signed-fixture-token'}):Response.json(response);
  await assert.rejects(maintenanceStatus({kind:'smoke',env,fetcher}),/INVALID_MAINTENANCE_STATUS/);
 }
});
