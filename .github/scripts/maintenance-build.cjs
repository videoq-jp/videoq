// Build without runtime credentials; always resolve Wrangler output before it
// interprets a relative outdir against the configuration file's directory.
const {resolve,join}=require('node:path');
const {mkdtempSync,writeFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {execFileSync}=require('node:child_process');
const {deploymentConfig}=require('./maintenance-deployment.cjs');
function buildMaintenance({root=resolve(__dirname,'../..'),outdir,env=process.env,execute=execFileSync}={}){
 if(typeof outdir!=='string'||!outdir.trim())throw Error('MAINTENANCE_ARTIFACT_DIRECTORY_REQUIRED');
 const artifact=resolve(root,outdir);if(artifact===resolve(root))throw Error('MAINTENANCE_ARTIFACT_DIRECTORY_REQUIRED');
 const wrangler=join(root,'.github/deploy-tools/node_modules/wrangler/bin/wrangler.js');
 const child=Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>env[k]).map(k=>[k,env[k]]));Object.assign(child,{CI:'true',WRANGLER_SEND_METRICS:'false'});
 const options={cwd:root,env:child,stdio:'inherit'};
 execute(process.execPath,[wrangler,'deploy','--config',join(root,'infra/cloudflare-maintenance/wrangler.jsonc'),'--dry-run','--outdir',artifact,'--no-autoconfig','--env-file','/dev/null'],options);
 // Validate the actual bundled entry before publishing any artifact. A README
 // alone is not a successful build, even though upload-artifact accepts it.
 const config=deploymentConfig({artifact,enabled:'false'});
 const directory=mkdtempSync(join(tmpdir(),'videoq-maintenance-upload-check-'));
 try{
  const path=join(directory,'deployment.json');writeFileSync(path,JSON.stringify(config)+'\n',{mode:0o600});
  execute(process.execPath,[wrangler,'deploy','--config',path,'--no-bundle','--no-autoconfig','--dry-run','--env-file','/dev/null'],options);
 }finally{rmSync(directory,{recursive:true,force:true});}
 return artifact;
}
if(require.main===module)buildMaintenance({outdir:process.argv[2]});
module.exports={buildMaintenance};
