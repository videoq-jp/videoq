const {createBackgroundMigrationReadTransport}=require('./background-migration-fence.cjs');
const ACCOUNT='12daec56fdba43f677f2766ee26a5a39';
function createBackgroundMaintenanceTransport({token,fetcher=fetch}){
 const read=createBackgroundMigrationReadTransport({token,fetcher});
 return async(method,path,body)=>{
  if(method==='GET')return read(method,path);
  const prefix=`accounts/${ACCOUNT}/`,relative=path.startsWith(prefix)?path.slice(prefix.length):'';
  const queue=/^queues\/[a-f0-9]{32}$/.test(relative)&&body&&Object.keys(body).join(',')==='settings'&&body.settings&&Object.keys(body.settings).join(',')==='delivery_paused'&&typeof body.settings.delivery_paused==='boolean';
  const workflow=/^workflows\/videoq-search-index-prod\/instances\/[\w-]{1,100}\/status$/.test(relative)&&body&&Object.keys(body).join(',')==='status'&&['pause','resume'].includes(body.status);
  if(method!=='PATCH'||!queue&&!workflow)throw Error('BACKGROUND_MAINTENANCE_WRITE_SCOPE_REQUIRED');
  if(queue){
   const current=(await read('GET',path)).result;
   if(current?.queue_id!==relative.slice('queues/'.length)||!['videoq-account-prod','videoq-search-prod'].includes(current.queue_name))throw Error('BACKGROUND_MAINTENANCE_QUEUE_SCOPE_REQUIRED');
  }
  const response=await fetcher('https://api.cloudflare.com/client/v4/'+path,{method:'PATCH',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('BACKGROUND_MAINTENANCE_WRITE_FAILED');
  // Both controls verify authoritative GET metadata after this call. Never
  // trust or expose mutation response bodies (including lost acknowledgements).
  await response.body?.cancel();return{success:true};
 };
}
module.exports={createBackgroundMaintenanceTransport};
