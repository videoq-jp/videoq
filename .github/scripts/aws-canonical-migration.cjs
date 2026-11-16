// Invoked only by the immutable migration CodeBuild job after fetching and
// installing the exact source's separately locked deployment tools.
const {resolve,join}=require('node:path');
const {readFileSync,readdirSync}=require('node:fs');
const {execFileSync}=require('node:child_process');
const m=require('./neon-admin.cjs');
const {migrationTarget}=require('./migration-backend.cjs');
const {readDeploymentSettings,assertDeploymentPreservesState}=require('./protect-api-deployment.cjs');
const ACCOUNT='12daec56fdba43f677f2766ee26a5a39';
const PARAMETER='/videoq/security/prod/d1-migration';
async function runCanonicalMigration({env=process.env,root=resolve('migration-source'),operatorRoot=resolve(__dirname,'../..'),aws=m.aws,readParameter=m.readParameter,execute=execFileSync,fetcher=fetch,readConfig,readMigrations=()=>readdirSync(join(root,'apps/api/drizzle-d1')).filter(n=>n.endsWith('.sql')).sort()}={}) {
  const run=env.MAINTENANCE_RUN_ID,source=env.MAINTENANCE_SOURCE_SHA;
  if (env.MAINTENANCE_KIND!=='migration'||env.MAINTENANCE_STAGE!=='migration'||env.MAINTENANCE_TABLE!=='videoq-db-maintenance-prod'
    ||!/^[a-f0-9]{32}$/.test(run??'')||!/^[a-f0-9]{40}$/.test(source??'')||env.GITHUB_ACTIONS
    ||!/^arn:aws:codebuild:ap-northeast-1:257240362763:build\/videoq-db-migration-prod:[a-f0-9-]{36}$/.test(env.CODEBUILD_BUILD_ARN??'')) throw Error('AWS_MIGRATION_CONTEXT_REQUIRED');
  let config;
  if(readConfig) config=readConfig();
  else {
    const errors=[];
    config=require(join(root,'.github/deploy-tools/node_modules/jsonc-parser')).parse(readFileSync(join(root,'apps/api/wrangler.jsonc'),'utf8'),errors);
    if(errors.length) throw Error('INVALID_MIGRATION_CONFIGURATION');
  }
  const target=migrationTarget(config);
  if(target.backend==='postgres') {
    execute('python3',[join(operatorRoot,'.github/scripts/with-neon-credentials.py'),'migration','sh','apps/api/scripts/db-migrate.sh'],
      {cwd:root,stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024,env:{...env,STRUCTURED_ANSWER_WRITERS_STOPPED:env.MAINTENANCE_WRITERS_STOPPED==='true'?'1':'0'}});
    return {backend:'postgres',source_sha:source};
  }
  if(!['true','false'].includes(env.MAINTENANCE_WRITERS_STOPPED))throw Error('INVALID_MIGRATION_WRITER_STATE');
  const arn='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run;
  const ownership=()=>{
    const get=key=>aws('dynamodb','get-item',{TableName:env.MAINTENANCE_TABLE,Key:{pk:{S:key}},ConsistentRead:true}).Item;
    const row=get('run#'+run),lock=get('maintenance');
    if(row?.kind?.S!=='migration'||row.execution_arn?.S!==arn||lock?.kind?.S!=='migration'||lock.execution_arn?.S!==arn) throw Error('D1_MIGRATION_OWNERSHIP_REQUIRED');
    let input;try{input=JSON.parse(lock.input.S);}catch{throw Error('D1_MIGRATION_SOURCE_MISMATCH');}
    if(input.source_sha!==source||input.kind!=='migration'||input.writers_stopped!==(env.MAINTENANCE_WRITERS_STOPPED==='true')) throw Error('D1_MIGRATION_SOURCE_MISMATCH');
  };
  ownership();
  const secret=readParameter(PARAMETER);
  if(secret.CLOUDFLARE_ACCOUNT_ID!==ACCOUNT||typeof secret.CLOUDFLARE_API_TOKEN!=='string'||secret.CLOUDFLARE_API_TOKEN.length<20||secret.CLOUDFLARE_API_TOKEN.length>4096||/[\r\n\0]/.test(secret.CLOUDFLARE_API_TOKEN)) throw Error('INVALID_D1_MIGRATION_CREDENTIAL');
  const cf={CLOUDFLARE_ACCOUNT_ID:ACCOUNT,CLOUDFLARE_API_TOKEN:secret.CLOUDFLARE_API_TOKEN};
  const settings=await readDeploymentSettings(cf,fetcher);
  assertDeploymentPreservesState(settings,target.production);
  if(env.MAINTENANCE_WRITERS_STOPPED==='false'){
    // Ordinary code-only CD may inspect an already active D1. It cannot create
    // or migrate a DB, change backend, or infer a writer stop from an empty diff.
    const actual=settings.bindings.find(b=>b.name==='PERSISTENCE_BACKEND')?.text??(settings.bindings.find(b=>b.name==='DEPLOYMENT_EDITION')?.text==='cloud'?'d1':'postgres');
    if(actual!=='d1')throw Error('D1_MIGRATION_REQUIRES_DRAINED_WRITERS');
    const expected=readMigrations();
    if(!Array.isArray(expected)||!expected.length||expected.length>500||new Set(expected).size!==expected.length||expected.some(n=>typeof n!=='string'||!/^\d{4}_[a-z0-9_]+\.sql$/.test(n)))throw Error('INVALID_D1_MIGRATION_INVENTORY');
    const id=target.production.d1_databases[0].database_id;
    const response=await fetcher('https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT+'/d1/database/'+id+'/query',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+secret.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},body:JSON.stringify({sql:'SELECT name FROM d1_migrations ORDER BY name LIMIT 501',params:[]})});
    if(!response.ok||!response.body)throw Error('D1_MIGRATION_LEDGER_UNAVAILABLE');
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.byteLength;if(size>128*1024)throw Error('D1_MIGRATION_LEDGER_UNAVAILABLE');chunks.push(Buffer.from(chunk));}
    let ledger;try{ledger=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('D1_MIGRATION_LEDGER_UNAVAILABLE');}
    const rows=ledger?.result?.[0]?.results;
    if(ledger?.success!==true||ledger.result?.length!==1||ledger.result[0].success!==true||!Array.isArray(rows)||rows.length>500||rows.some(r=>!r||Object.keys(r).join(',')!=='name'||typeof r.name!=='string'))throw Error('D1_MIGRATION_LEDGER_UNAVAILABLE');
    const names=rows.map(r=>r.name);
    if(new Set(names).size!==names.length||names.some(n=>!expected.includes(n)))throw Error('D1_MIGRATION_LEDGER_DIVERGED');
    if(JSON.stringify(names.toSorted())!==JSON.stringify(expected.toSorted()))throw Error('D1_MIGRATION_REQUIRES_DRAINED_WRITERS');
    ownership();const after=await readDeploymentSettings(cf,fetcher);assertDeploymentPreservesState(after,target.production);
    const selected=after.bindings.find(b=>b.name==='PERSISTENCE_BACKEND')?.text??(after.bindings.find(b=>b.name==='DEPLOYMENT_EDITION')?.text==='cloud'?'d1':'postgres');
    if(selected!=='d1')throw Error('D1_MIGRATION_BACKEND_CHANGED');
    return{backend:'d1',source_sha:source,read_only:true,migrations_pending:false};
  }
  const pause=settings.bindings.filter(binding=>binding.name==='MIGRATION_TRAFFIC_STATE');
  if(pause.length!==1||pause[0].type!=='plain_text'||pause[0].text!=='paused') throw Error('D1_MIGRATION_REQUIRES_PAUSED_API');
  ownership();
  const childEnv=Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>env[k]).map(k=>[k,env[k]]));
  Object.assign(childEnv,cf,{CI:'true',WRANGLER_SEND_METRICS:'false'});
  execute(process.execPath,[join(root,'.github/deploy-tools/node_modules/wrangler/bin/wrangler.js'),'d1','migrations','apply','DB','--remote','--config',join(root,'apps/api/wrangler.jsonc'),'--env','production','--env-file','/dev/null'],
    {cwd:root,env:childEnv,stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024,timeout:900000});
  ownership();
  // A failure retains application pause; never reopen traffic here.
  const after=await readDeploymentSettings(cf,fetcher);
  assertDeploymentPreservesState(after,target.production);
  if(after.bindings.find(binding=>binding.name==='MIGRATION_TRAFFIC_STATE')?.text!=='paused') throw Error('D1_MIGRATION_PAUSE_CHANGED');
  return {backend:'d1',source_sha:source,application_paused:true};
}
module.exports={runCanonicalMigration};
