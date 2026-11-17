// Read-only storage/origin boundary for a future isolated E2E runner. This is
// not a resource provisioner or proof of Lambda/SQS/model credential isolation.
const ACCOUNT='12daec56fdba43f677f2766ee26a5a39';
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const RESERVED=new Set(['e57d0931-18cb-4f00-ae7f-b0068030fb04','587bd210-6d9d-4f32-abb7-a490013e65d3','373d6ca5-2796-460d-8ab1-e644de46bb3c','8e84cb18-4712-48cf-b528-e880188b045f','538bebc4-9485-4e91-8799-c236eeed1dd2']);
function validate(manifest,now=Date.now()){
 if(!manifest||Object.keys(manifest).sort().join(',')!=='databaseId,expiresAt,issuedAt,nonce,version,workersSubdomain'||manifest.version!==1||!/^[a-f0-9]{16}$/.test(manifest.nonce??'')||!UUID.test(manifest.databaseId??'')||RESERVED.has(manifest.databaseId)||!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(manifest.workersSubdomain??'')||![manifest.issuedAt,manifest.expiresAt,now].every(Number.isSafeInteger)||manifest.issuedAt>now||manifest.expiresAt<=now||manifest.expiresAt<=manifest.issuedAt||manifest.expiresAt-manifest.issuedAt>2*60*60*1000)throw Error('ISOLATED_SMOKE_MANIFEST_REQUIRED');
 const {nonce,databaseId,workersSubdomain}=manifest,worker='videoq-isolated-api-'+nonce;
 return Object.freeze({accountId:ACCOUNT,nonce,databaseId,worker,origin:`https://${worker}.${workersSubdomain}.workers.dev`,workersSubdomain,databaseName:'videoq-isolated-db-'+nonce,bucket:'videoq-isolated-media-'+nonce,largeIndex:`videoq-isolated-scenes-${nonce}-1536`,smallIndex:`videoq-isolated-scenes-${nonce}-768`});
}
function createIsolatedSmokeTarget({manifest,env=process.env,fetcher=fetch,now=Date.now}){
 const original=Object.freeze(structuredClone(manifest)),target=validate(original,now());
 if(env.CLOUDFLARE_ACCOUNT_ID!==ACCOUNT||typeof env.CLOUDFLARE_API_TOKEN!=='string'||env.CLOUDFLARE_API_TOKEN.length<20||env.CLOUDFLARE_API_TOKEN.length>4096||/[\r\n\0]/.test(env.CLOUDFLARE_API_TOKEN)||typeof fetcher!=='function')throw Error('ISOLATED_SMOKE_CREDENTIAL_REQUIRED');
 const token=env.CLOUDFLARE_API_TOKEN,prefix=`accounts/${ACCOUNT}/`;
 const paths=[`workers/subdomain`,`workers/scripts/${target.worker}/settings`,`d1/database/${target.databaseId}`,`vectorize/v2/indexes/${target.largeIndex}`,`vectorize/v2/indexes/${target.smallIndex}`,`r2/buckets/${target.bucket}`].map(v=>prefix+v);
 async function read(path){
  try{
   const response=await fetcher('https://api.cloudflare.com/client/v4/'+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+token}});
   if(!response.ok||!response.body){await response.body?.cancel();throw Error('status');}
   const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.byteLength;if(size>1024*1024){await response.body.cancel().catch(()=>{});throw Error('limit');}chunks.push(Buffer.from(chunk));}
   const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(value.success!==true||value.errors?.length||!value.result||typeof value.result!=='object'||Array.isArray(value.result))throw Error('shape');return value.result;
  }catch{throw Error('ISOLATED_SMOKE_METADATA_UNAVAILABLE');}
 }
 return Object.freeze({
  ...target,
  uploadAllowed(value){try{validate(original,now());const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&url.host===ACCOUNT+'.r2.cloudflarestorage.com'&&url.pathname.startsWith('/'+target.bucket+'/');}catch{return false;}},
  async assertTarget(){
   validate(original,now());const [subdomain,settings,database,large,small,bucket]=await Promise.all(paths.map(read));
   if(subdomain.subdomain!==target.workersSubdomain||database.uuid!==target.databaseId||database.name!==target.databaseName||bucket.name!==target.bucket||large.name!==target.largeIndex||large.config?.dimensions!==1536||large.config.metric!=='cosine'||small.name!==target.smallIndex||small.config?.dimensions!==768||small.config.metric!=='cosine'||!Array.isArray(settings.bindings)||settings.bindings.some(v=>!v||typeof v.name!=='string')||new Set(settings.bindings.map(v=>v.name)).size!==settings.bindings.length)throw Error('ISOLATED_SMOKE_TARGET_DRIFT');
   if(settings.bindings.some(v=>v.type==='hyperdrive')||settings.bindings.filter(v=>v.type==='d1').length!==1||settings.bindings.filter(v=>v.type==='vectorize').length!==2||settings.bindings.filter(v=>v.type==='r2_bucket').length!==1)throw Error('ISOLATED_SMOKE_TARGET_DRIFT');
   const one=(name,type)=>{const rows=settings.bindings.filter(v=>v.name===name&&v.type===type);if(rows.length!==1)throw Error('ISOLATED_SMOKE_TARGET_DRIFT');return rows[0];};
   const db=one('DB','d1');if(db.id!==target.databaseId||db.database_id!==undefined&&db.database_id!==db.id||one('SCENE_VECTORIZE_1536','vectorize').index_name!==target.largeIndex||one('SCENE_VECTORIZE_768','vectorize').index_name!==target.smallIndex||one('VIDEO_BUCKET','r2_bucket').bucket_name!==target.bucket)throw Error('ISOLATED_SMOKE_TARGET_DRIFT');
   for(const [name,text] of Object.entries({DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1',MIGRATION_TRAFFIC_STATE:'running',BETTER_AUTH_URL:target.origin,OAUTH_ISSUER_URL:target.origin,FRONTEND_URL:target.origin,CORS_ALLOW_ORIGIN:target.origin,R2_BUCKET_NAME:target.bucket}))if(one(name,'plain_text').text!==text)throw Error('ISOLATED_SMOKE_TARGET_DRIFT');
   validate(original,now());return{storageAndOriginVerified:true};
  },
 });
}
module.exports={validateIsolatedSmokeManifest:validate,createIsolatedSmokeTarget};
