const {createHash}=require('node:crypto');
const URL='https://videoq-maintenance-prod.yukiharada1228.workers.dev';
const AUDIENCE='videoq-maintenance-prod';
function context(kind,env){
 if(!['migration','smoke'].includes(kind)||env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!=='videoq-jp/videoq'||env.GITHUB_REF!=='refs/heads/main'
  ||!/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID??'')||!/^[1-9]\d{0,5}$/.test(env.GITHUB_RUN_ATTEMPT??'')||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA??'')||env.GITHUB_WORKFLOW_SHA!==env.GITHUB_SHA)throw Error('GITHUB_MAINTENANCE_CONTEXT_REQUIRED');
 return{run:createHash('sha256').update('"github:'+kind+':'+env.GITHUB_RUN_ID+'"').digest('hex').slice(0,32),source:env.GITHUB_SHA,kind};
}
async function createClient({kind,env=process.env,fetcher=fetch,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 const identity=context(kind,env),{boundedJson}=await import('../../infra/cloudflare-maintenance/auth.mjs');
 const request=async body=>{
  for(let attempt=0;attempt<3;attempt++){
   try{
    const tokenUrl=new globalThis.URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    if(tokenUrl.protocol!=='https:'||!tokenUrl.hostname.endsWith('.actions.githubusercontent.com')||!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN||!env.GH_MAINTENANCE_READ_TOKEN)throw Error('GITHUB_OIDC_UNAVAILABLE');
    tokenUrl.searchParams.set('audience',AUDIENCE);
    const token=await boundedJson(await fetcher(tokenUrl,{headers:{authorization:'Bearer '+env.ACTIONS_ID_TOKEN_REQUEST_TOKEN},redirect:'error',signal:AbortSignal.timeout(10000)}),24000);
    if(typeof token.value!=='string'||token.value.length>20000)throw Error('GITHUB_OIDC_UNAVAILABLE');
    const response=await fetcher(URL+'/v1/'+kind,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:'Bearer '+token.value,'x-github-token':env.GH_MAINTENANCE_READ_TOKEN,'content-type':'application/json'},body:JSON.stringify(body)});
    if(response.status>=500)throw Error('MAINTENANCE_UNAVAILABLE');
    const value=await boundedJson(new Response(response.body),70000);
    if(!response.ok){const code=/^[A-Z_]{1,80}$/.test(value.error??'')?value.error:'MAINTENANCE_REFUSED';throw Object.assign(Error(code),{terminal:true});}
    return value;
   }catch(error){if(error?.terminal||attempt===2)throw Error(error?.terminal?error.message:'MAINTENANCE_UNAVAILABLE');await sleep(1000);}
  }
 };
 return{...identity,request,
  acquire:writersStopped=>request({action:'acquire',writersStopped}),
  assert:()=>request({action:'assert'}),
  plans:{async load(key){return(await request({action:'load',key})).value;},async save(key,value){await request({action:'save',key,value});}},
  async finish(value){await request({action:'save',key:'operation-result',value:{version:1,kind,run:identity.run,source:identity.source,...value}});await request({action:'complete'});return request({action:'release'});},
  fail:()=>request({action:'fail'}),
 };
}
module.exports={context,createClient};
