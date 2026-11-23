// Read-only GitHub OIDC proof and global owner inventory. No runtime credentials.
const {createClient}=require('./cloudflare-maintenance-client.cjs');
async function maintenanceStatus({kind,env=process.env,fetcher=fetch}={}){
 const client=await createClient({kind,env,fetcher});
 const value=await client.status(),owner=value?.owner;
 if(!value||Object.keys(value).length!==1||!Object.hasOwn(value,'owner'))throw Error('INVALID_MAINTENANCE_STATUS');
 if(owner!==null&&(typeof owner!=='object'||Object.keys(owner).length!==7||!/^[a-f0-9]{32}$/.test(owner.run??'')||!/^[a-f0-9]{40}$/.test(owner.source??'')||!/^[1-9][0-9]{0,19}$/.test(owner.githubRun??'')||!['migration','smoke'].includes(owner.kind)||!['running','failed','completed'].includes(owner.state)||!Number.isSafeInteger(owner.attempt)||owner.attempt<1||typeof owner.writersStopped!=='boolean'))throw Error('INVALID_MAINTENANCE_STATUS');
 return{kind,owner};
}
if(require.main===module)maintenanceStatus({kind:process.argv[2]}).then(value=>console.log(JSON.stringify(value))).catch(error=>{const code=/^[A-Z_]{1,80}$/.test(error?.message??'')?error.message:'MAINTENANCE_STATUS_UNAVAILABLE';console.error(code);process.exitCode=1;});
module.exports={maintenanceStatus};
