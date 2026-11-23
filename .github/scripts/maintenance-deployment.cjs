// Produce an upload-only config from reviewed source, never artifact metadata.
const {readFileSync,writeFileSync,statSync}=require('node:fs');
const {resolve}=require('node:path');
function deploymentConfig({artifact,enabled}){
 if(!['true','false'].includes(enabled))throw Error('INVALID_MAINTENANCE_SWITCH');
 const config=JSON.parse(readFileSync(resolve(__dirname,'../../infra/cloudflare-maintenance/wrangler.jsonc'),'utf8'));
 const main=resolve(artifact,'worker.js');if(!statSync(main).isFile())throw Error('MAINTENANCE_ARTIFACT_REQUIRED');
 delete config.$schema;
 return{...config,main,vars:{MAINTENANCE_ENABLED:enabled},no_bundle:true};
}
if(require.main===module)writeFileSync(process.argv[3],JSON.stringify(deploymentConfig({artifact:process.argv[2],enabled:process.env.CLOUDFLARE_MAINTENANCE_ENABLED||'false'}))+'\n',{mode:0o600});
module.exports={deploymentConfig};
