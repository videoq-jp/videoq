'use strict';
// Wrangler builds immutable artifacts; Terraform alone uploads versions and switches traffic.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const ACCOUNT = '12daec56fdba43f677f2766ee26a5a39';
const WORKERS = {api:'videoq-api',web:'videoq-web',docs:'videoq-docs',maintenance:'videoq-maintenance-prod'};
function releaseVersion(config, settings, versionId, migrationTag) {
  const existing = new Map(settings.bindings.map(binding=>[binding.name,binding]));
  const bindings = new Map();
  const add = binding=>{if(bindings.has(binding.name))throw Error('DUPLICATE_BINDING');bindings.set(binding.name,binding);};
  for (const binding of settings.bindings) if (binding.type === 'secret_text' || binding.type === 'secret_key') add({type:'inherit',name:binding.name,version_id:versionId});
  for (const [name,value] of Object.entries(config.vars || {})) {
    if (bindings.has(name)) throw Error('SECRET_BINDING_CANNOT_BECOME_PLAINTEXT');
    add(typeof value === 'string' ? {type:'plain_text',name,text:value} : {type:'json',name,json:JSON.stringify(value)});
  }
  for (const binding of config.d1_databases || []) add({type:'d1',name:binding.binding,id:binding.database_id});
  for (const binding of config.r2_buckets || []) add({type:'r2_bucket',name:binding.binding,bucket_name:binding.bucket_name});
  for (const binding of config.vectorize || []) add({type:'vectorize',name:binding.binding,index_name:binding.index_name});
  for (const binding of config.queues?.producers || []) add({type:'queue',name:binding.binding,queue_name:binding.queue,...(binding.delivery_delay !== undefined ? {delivery_delay:binding.delivery_delay}: {})});
  for (const binding of config.workflows || []) add({type:'workflow',name:binding.binding,workflow_name:binding.name,class_name:binding.class_name,...(binding.script_name ? {script_name:binding.script_name}:{})});
  for (const binding of config.durable_objects?.bindings || []) {
    const current=existing.get(binding.name);
    if (current?.type !== 'durable_object_namespace' || current.class_name !== binding.class_name || !current.namespace_id) throw Error('DURABLE_OBJECT_MIGRATION_REQUIRES_REVIEWED_TERRAFORM_CHANGE');
    add({type:'durable_object_namespace',name:binding.name,class_name:binding.class_name,namespace_id:current.namespace_id,...(binding.script_name ? {script_name:binding.script_name}:{})});
  }
  if (config.ai) add({type:'ai',name:config.ai.binding});
  if (config.assets?.binding) add({type:'assets',name:config.assets.binding});
  if (config.hyperdrive?.length || config.services?.length || config.kv_namespaces?.length) throw Error('UNREVIEWED_BINDING_TYPE');
  const crons=config.triggers?.crons || [];
  const expected=config.name==='videoq-api'?['17 3 * * *']:[];
  if(JSON.stringify(crons)!==JSON.stringify(expected))throw Error('CRON_DEFINITIONS_BELONG_TO_TERRAFORM_FOUNDATION');
  const lastMigration=config.migrations?.at(-1)?.tag;
  if (lastMigration && lastMigration !== migrationTag) throw Error('DURABLE_OBJECT_MIGRATION_TAG_REQUIRES_REVIEW');
  const result={compatibility_date:config.compatibility_date,compatibility_flags:config.compatibility_flags || [],bindings:[...bindings.values()]};
  if (config.main) {
    const directory=path.dirname(config.main);const modules=[];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
        const filename=path.join(dir,entry.name);
        if (entry.isSymbolicLink()) throw Error('ARTIFACT_SYMLINK_REJECTED');
        if (entry.isDirectory()) {walk(filename);continue;}
        if (entry.name.endsWith('.map') || entry.name === 'README.md') continue;
        const type=/\.(?:js|mjs)$/.test(entry.name)?'application/javascript+module':entry.name.endsWith('.wasm')?'application/wasm':'text/plain';
        modules.push({name:path.relative(directory,filename).split(path.sep).join('/'),content_type:type,content_base64:fs.readFileSync(filename).toString('base64')});
      }
    }
    walk(directory);result.main_module=path.basename(config.main);result.modules=modules;
    // Static asset headers are also runtime modules, independent of hashed imports.
    for (const name of ['_headers','_redirects']) {
      const file=config.assets && path.join(config.assets.directory,name);
      if(file && fs.existsSync(file) && !modules.some(module=>module.name===name)) modules.push({name,content_type:'text/plain',content_base64:fs.readFileSync(file).toString('base64')});
    }
  }
  if (config.assets) {
    const {directory,binding,...assetConfig}=config.assets;
    result.assets={directory,config:assetConfig};
  }
  return result;
}
async function main() {
  const [component,configPath]=process.argv.slice(2);const name=WORKERS[component];
  if (!name || !configPath) throw Error('EXPECTED_COMPONENT_AND_TRUSTED_CONFIG');
  const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
  if (config.name !== name) throw Error('WRONG_PRODUCTION_WORKER');
  if (!process.env.CLOUDFLARE_API_TOKEN) throw Error('CLOUDFLARE_API_TOKEN_REQUIRED');
  const root=path.resolve(__dirname,'../..');const work=fs.mkdtempSync(path.join(os.tmpdir(),'videoq-release-'));
  const wrapper=path.join(root,'infra/bin/terraform-r2.cjs');const rootArg='-chdir='+path.join(root,'infra/cloudflare-releases',component);
  function tf(args,{json=false}={}) {
    const result=spawnSync(process.execPath,[wrapper,rootArg,...args],{encoding:'utf8',maxBuffer:96*1024*1024});
    fs.writeFileSync(path.join(work,`terraform-${args[0]}.log`),result.stdout+result.stderr,{mode:0o600});
    if(result.status!==0) {
      for(const line of result.stdout.split('\n'))try{const e=JSON.parse(line);if(e.type==='diagnostic' && e.diagnostic.severity==='error')console.error(e.diagnostic.summary);}catch{}
      throw Error(`TERRAFORM_${args[0].toUpperCase()}_FAILED`);
    }
    return json?JSON.parse(result.stdout):result.stdout;
  }
  async function api(suffix) {
    const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${name}/${suffix}`,{headers:{Authorization:'Bearer '+process.env.CLOUDFLARE_API_TOKEN},redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error('CLOUDFLARE_DEPLOYMENT_READ_FAILED');const data=await response.json();if(!data.success)throw Error('CLOUDFLARE_API_ERROR');return data.result;
  }
  try {
    tf(['init','-lockfile=readonly','-input=false']);
    const state=tf(['state','pull'],{json:true});
    const version=state.resources.find(resource=>resource.type==='cloudflare_worker_version')?.instances[0].attributes;
    if(!version?.id)throw Error('TERRAFORM_RELEASE_MUST_BE_ADOPTED_FIRST');
    async function assertActive() {
      const live=await api('deployments');const active=live.deployments[0]?.versions;
      if(active?.length!==1 || active[0].version_id!==version.id || active[0].percentage!==100)throw Error('ACTIVE_VERSION_DRIFT_REQUIRES_RECONCILIATION');
    }
    await assertActive();
    const release={version:releaseVersion(config,await api('settings'),version.id,version.migration_tag)};
    if(/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA||''))release.version.annotations={workers_tag:process.env.GITHUB_SHA,workers_message:'VideoQ reviewed main '+process.env.GITHUB_SHA};
    const variables=path.join(work,'release.tfvars.json');fs.writeFileSync(variables,JSON.stringify({release}),{mode:0o600});
    const plan=path.join(work,'release.tfplan');
    tf(['plan','-json','-input=false','-var-file='+variables,'-out='+plan]);
    const proposed=tf(['show','-json',plan],{json:true});
    for(const resource of proposed.resource_changes || []) {
      if(!['module.release.cloudflare_worker_version.release','module.release.cloudflare_workers_deployment.active'].includes(resource.address))throw Error('UNEXPECTED_RELEASE_RESOURCE');
      if(resource.change.actions.includes('delete') && !['cloudflare_worker_version','cloudflare_workers_deployment'].includes(resource.type))throw Error('UNEXPECTED_INFRASTRUCTURE_DELETION');
    }
    await assertActive();
    tf(['apply','-json','-input=false',plan]);
    console.log(`Deployed ${name} through Terraform with R2 state.`);
  } finally {fs.rmSync(work,{recursive:true,force:true});}
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={releaseVersion};
