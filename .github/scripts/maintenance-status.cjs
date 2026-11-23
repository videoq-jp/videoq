// Read-only GitHub OIDC proof and global owner inventory. No runtime credentials.
const {createClient}=require('./cloudflare-maintenance-client.cjs');
async function maintenanceStatus({kind,env=process.env,fetcher=fetch}={}){
 const client=await createClient({kind,env,fetcher});
 const value=await client.status(),owner=value?.owner;
 if(!value||Object.keys(value).length!==1||!Object.hasOwn(value,'owner'))throw Error('INVALID_MAINTENANCE_STATUS');
 if(owner!==null&&(typeof owner!=='object'||Object.keys(owner).length!==7||!/^[a-f0-9]{32}$/.test(owner.run??'')||!/^[a-f0-9]{40}$/.test(owner.source??'')||!/^[1-9][0-9]{0,19}$/.test(owner.githubRun??'')||!['migration','smoke'].includes(owner.kind)||!['running','failed','completed'].includes(owner.state)||!Number.isSafeInteger(owner.attempt)||owner.attempt<1||typeof owner.writersStopped!=='boolean'))throw Error('INVALID_MAINTENANCE_STATUS');
 return{kind,owner};
}
async function diagnosticFetch(url,options){
 const response=await fetch(url,options);
 if(new URL(url).hostname.endsWith('.actions.githubusercontent.com')&&response.ok){
  try{
   const {value}=await response.clone().json();
   const c=JSON.parse(Buffer.from(value.split('.')[1],'base64url').toString('utf8'));
   const kind=process.argv[2],seconds=Math.floor(Date.now()/1000);
   const checks={issuer:c.iss==='https://token.actions.githubusercontent.com',audience:c.aud==='videoq-maintenance-prod',repository:c.repository==='videoq-jp/videoq',repositoryId:c.repository_id==='1083911938',ownerId:c.repository_owner_id==='349188820',ref:c.ref==='refs/heads/main',refType:c.ref_type==='branch',environment:c.environment==='production-db-'+kind,runner:c.runner_environment==='github-hosted',subject:c.sub==='repo:videoq-jp/videoq:environment:production-db-'+kind,event:c.event_name==='workflow_dispatch',workflow:c.workflow_ref==='videoq-jp/videoq/.github/workflows/maintenance-status.yml@refs/heads/main',source:c.sha===process.env.GITHUB_SHA&&c.workflow_sha===c.sha,run:c.run_id===process.env.GITHUB_RUN_ID&&c.run_attempt===process.env.GITHUB_RUN_ATTEMPT,integerTimes:[c.exp,c.iat,c.nbf].every(Number.isSafeInteger),unexpired:c.exp>seconds,notBefore:c.nbf<=seconds+30,issued:c.iat<=seconds+30&&c.iat>=seconds-600,lifetime:c.exp-c.iat<=600};
   console.log(JSON.stringify({identityChecks:checks}));
  }catch{console.log('IDENTITY_DIAGNOSTIC_UNAVAILABLE');}
 }
 return response;
}
if(require.main===module)maintenanceStatus({kind:process.argv[2],fetcher:diagnosticFetch}).then(value=>console.log(JSON.stringify(value))).catch(error=>{const code=/^[A-Z_]{1,80}$/.test(error?.message??'')?error.message:'MAINTENANCE_STATUS_UNAVAILABLE';console.error(code);process.exitCode=1;});
module.exports={maintenanceStatus};
