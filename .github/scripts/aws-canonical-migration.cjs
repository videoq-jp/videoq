// Invoked only by the immutable migration CodeBuild job after fetching and
// installing the exact source's separately locked deployment tools.
const {resolve,join}=require('node:path');
const {readFileSync,readdirSync}=require('node:fs');
const {execFileSync}=require('node:child_process');
const m=require('./neon-admin.cjs');
const {migrationTarget}=require('./migration-backend.cjs');
const {createCanonicalBackgroundMaintenance,verifyBackgroundMaintenance}=require('./canonical-background-maintenance.cjs');
const ACCOUNT='12daec56fdba43f677f2766ee26a5a39';
const PARAMETER='/videoq/security/prod/d1-migration';
async function runCanonicalMigration({env=process.env,root=resolve('migration-source'),operatorRoot=resolve(__dirname,'../..'),aws=m.aws,readParameter=m.readParameter,execute=execFileSync,fetcher=fetch,readConfig,now=Date.now,sleep,readMigrations=()=>readdirSync(join(root,'apps/api/drizzle-d1')).filter(n=>n.endsWith('.sql')).sort()}={}) {
  const run=env.MAINTENANCE_RUN_ID,source=env.MAINTENANCE_SOURCE_SHA;
  if(env.MAINTENANCE_BACKGROUND_VERIFICATION!==undefined&&!['true','false'].includes(env.MAINTENANCE_BACKGROUND_VERIFICATION))throw Error('INVALID_BACKGROUND_VERIFICATION');
  const verificationOnly=env.MAINTENANCE_BACKGROUND_VERIFICATION==='true';
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
    if(verificationOnly)throw Error('BACKGROUND_VERIFICATION_D1_REQUIRED');
    execute('python3',[join(operatorRoot,'.github/scripts/with-neon-credentials.py'),'migration','sh','apps/api/scripts/db-migrate.sh'],
      {cwd:root,stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024,env:{...env,STRUCTURED_ANSWER_WRITERS_STOPPED:env.MAINTENANCE_WRITERS_STOPPED==='true'?'1':'0'}});
    return {backend:'postgres',source_sha:source};
  }
  const arn='arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-'+run;
  const ownership=()=>{
    const get=key=>aws('dynamodb','get-item',{TableName:env.MAINTENANCE_TABLE,Key:{pk:{S:key}},ConsistentRead:true}).Item;
    const row=get('run#'+run),lock=get('maintenance');
    if(row?.kind?.S!=='migration'||row.execution_arn?.S!==arn||lock?.kind?.S!=='migration'||lock.execution_arn?.S!==arn) throw Error('D1_MIGRATION_OWNERSHIP_REQUIRED');
    let input;try{input=JSON.parse(lock.input.S);}catch{throw Error('D1_MIGRATION_SOURCE_MISMATCH');}
    if(input.source_sha!==source||input.kind!=='migration'||input.writers_stopped!==(env.MAINTENANCE_WRITERS_STOPPED==='true')||(input.background_verification===true)!==verificationOnly) throw Error('D1_MIGRATION_SOURCE_MISMATCH');
  };
  return require('./owned-d1-migration.cjs').runOwnedD1Migration({env,root,target,run,source,assertOwnership:ownership,readCredential:purpose=>readParameter(purpose==='migration'?PARAMETER:'/videoq/security/prod/background-maintenance'),createMaintenance:options=>createCanonicalBackgroundMaintenance({aws,...options}),execute,fetcher,now,sleep,readMigrations,verificationOnly,verifyMaintenance:options=>verifyBackgroundMaintenance({aws,...options})});
}
module.exports={runCanonicalMigration};
