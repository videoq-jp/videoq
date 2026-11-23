// Shared D1 smoke body; the entry point supplies its actual maintenance owner.
const {join}=require('node:path');
async function runOwnedD1Smoke({env,root,cf,backend,readIdentity,assertOwnership,execute}){
 await assertOwnership();
 const identity=await readIdentity();
 if(!/^[a-f0-9]{64}$/.test(identity.key??''))throw Error('INVALID_SMOKE_IDENTITY_KEY');
 const child=Object.fromEntries(['PATH','HOME','TMPDIR','LANG'].filter(k=>env[k]).map(k=>[k,env[k]]));
 Object.assign(child,{VIDEOQ_SMOKE_BACKEND:'d1',VIDEOQ_SMOKE_D1_DATABASE_ID:backend.databaseId,VIDEOQ_SMOKE_IDENTITY_KEY:identity.key,CLOUDFLARE_ACCOUNT_ID:cf.CLOUDFLARE_ACCOUNT_ID,CLOUDFLARE_API_TOKEN:cf.CLOUDFLARE_API_TOKEN,VIDEOQ_BUNDLED_CHROMIUM:'true',VERIFY_AI_ANSWERS:env.VERIFY_AI_ANSWERS==='true'?'true':'false'});
 await assertOwnership();
 execute(process.execPath,[join(root,'.github/scripts/production-smoke.mjs')],{cwd:root,env:child,stdio:['ignore','pipe','pipe'],maxBuffer:8*1024*1024,timeout:20*60*1000});
 await assertOwnership();
 return{backend:'d1'};
}
module.exports={runOwnedD1Smoke};
