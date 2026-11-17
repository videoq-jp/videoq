// Read-only operator entry point. It never starts a hold/build, reads app/PG
// credentials, executes SQL or changes provider configuration.
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
const {verifyReviewedSource,executionEnv}=require('./run-cutover-admission.cjs');
const {createResourcePreflightAws,createResourceMetadataTransport,readResourcePlatform}=require('./d1-resource-preflight.cjs');
const ROOT=path.resolve(__dirname,'../..');
function parse(args){
 if(![2,4].includes(args.length))throw Error('RESOURCE_PREFLIGHT_ARGUMENTS_REQUIRED');const values={};
 for(let i=0;i<args.length;i+=2){if(!['--source','--project-sha256'].includes(args[i])||values[args[i]]!==undefined)throw Error('RESOURCE_PREFLIGHT_ARGUMENTS_REQUIRED');values[args[i]]=args[i+1];}
 if(!/^[a-f0-9]{40}$/.test(values['--source']??'')||values['--project-sha256']!==undefined&&!/^[a-f0-9]{64}$/.test(values['--project-sha256']))throw Error('RESOURCE_PREFLIGHT_ARGUMENTS_REQUIRED');
 return{source:values['--source'],expectedProjectSha256:values['--project-sha256']};
}
function checkedToken(value){if(typeof value!=='string'||value.length<20||value.length>4096||/[\r\n\0]/.test(value))throw Error('RESOURCE_PREFLIGHT_AUTH_REQUIRED');return value;}
function cloudflareToken({execute=execFileSync,env=process.env,root=ROOT}={}){
 if(env.CLOUDFLARE_API_TOKEN!==undefined)return checkedToken(env.CLOUDFLARE_API_TOKEN);
 const installed=path.join(root,'node_modules/.bin/wrangler'),wrangler=env.VIDEOQ_WRANGLER_BIN??(fs.existsSync(installed)?installed:'wrangler');
 if(typeof wrangler!=='string'||!wrangler||wrangler.includes('\0')||env.VIDEOQ_WRANGLER_BIN!==undefined&&!path.isAbsolute(wrangler))throw Error('RESOURCE_PREFLIGHT_WRANGLER_REQUIRED');
 const options={cwd:root,env:{...executionEnv(env,'git'),WRANGLER_SEND_METRICS:'false'},encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,maxBuffer:65536};
 try{
  const version=execute(wrangler,['--version'],options).trim();if(!/^4\.\d+\.\d+$/.test(version))throw Error('version');
  // Capture credentials only in process memory. Never forward this stdout to a
  // terminal/log. Wrangler refreshes existing OAuth credentials if necessary.
  const auth=JSON.parse(execute(wrangler,['auth','token','--json'],options));
  if(!['oauth','api_token'].includes(auth?.type))throw Error('type');return checkedToken(auth.token);
 }catch{throw Error('RESOURCE_PREFLIGHT_AUTH_REQUIRED');}
}
async function main({args=process.argv.slice(2),env=process.env,root=ROOT,execute=execFileSync,fetcher=fetch}={}){
 const requested=parse(args);
 if(env.GITHUB_ACTIONS||env.VIDEOQ_FENCE_ADMIN_DATABASE_URL||fs.realpathSync(root)!==fs.realpathSync(ROOT))throw Error('RESOURCE_PREFLIGHT_LOCAL_CONTEXT_REQUIRED');
 const reviewed=await verifyReviewedSource({source:requested.source,root,execute,env});
 const token=cloudflareToken({execute,env,root});
 const actual=await readResourcePlatform({aws:createResourcePreflightAws({execute,env,root}),cloudflare:createResourceMetadataTransport(token,{fetcher})});
 if(actual.reviewedSource!==requested.source)throw Error('RESOURCE_PREFLIGHT_SOURCE_REQUIRES_CD_REFRESH');
 if(requested.expectedProjectSha256&&requested.expectedProjectSha256!==actual.projectSha256)throw Error('RESOURCE_PREFLIGHT_SOURCE_OR_PROJECT_DRIFT');
 return{readOnly:true,reviewedSource:requested.source,currentMain:reviewed.currentMain,projectSha256:actual.projectSha256,platformSha256:actual.platformSha256};
}
module.exports={parse,cloudflareToken,main};
if(require.main===module)main().then(value=>console.log(JSON.stringify(value))).catch(()=>{console.error('RESOURCE_PREFLIGHT_FAILED: no hold, job, SQL or provider configuration was changed.');process.exitCode=1;});
