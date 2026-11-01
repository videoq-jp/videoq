// One-time/re-tokenization handoff through the existing reviewer-protected environment.
const {writeParameter}=require('./neon-admin.cjs');
const {HYPERDRIVE_ID,NEON_HOST,CF_PARAMETER}=require('./neon-policy.cjs');
(async()=>{
 if(process.env.GITHUB_REPOSITORY!=='videoq-jp/videoq'||process.env.GITHUB_REF!=='refs/heads/main') throw new Error('PRODUCTION_MAIN_ONLY');
 const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
 if(!/^[a-f0-9]{32}$/.test(account||'')||!token) throw new Error('CLOUDFLARE_CONFIGURATION_REQUIRED');
 const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/hyperdrive/configs/${HYPERDRIVE_ID}`,
  {headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(30000)});
 const data=await response.json();
 if(!response.ok||!data.success||data.result.id!==HYPERDRIVE_ID||data.result.origin.host.replace('-pooler.','.')!==NEON_HOST) throw new Error('HYPERDRIVE_BOOTSTRAP_VERIFICATION_FAILED');
 writeParameter(CF_PARAMETER,{account_id:account,api_token:token,initialized_at:new Date().toISOString()});
 console.log('Scoped Hyperdrive maintenance credential stored; no credential values were printed');
})().catch(e=>{console.error('Maintenance initialization failed: '+(/^[A-Z_]+$/.test(e.message)?e.message:e.name));process.exitCode=1;});
