// Actual workerd + SQLite Durable Object + real RSA JWT verification. No real
// GitHub/Cloudflare API, production data or credentials are used by this fixture.
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../deploy-tools/package.json',import.meta.url));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare'),{build}=require('esbuild');
const source='a'.repeat(40),attempts=new Map([['123',1],['124',1]]);
const keys=await webcrypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const publicKey={...await webcrypto.subtle.exportKey('jwk',keys.publicKey),kid:'native-fixture',alg:'RS256',use:'sig'};
async function token(run,attempt){const now=Math.floor(Date.now()/1000),encode=o=>Buffer.from(JSON.stringify(o)).toString('base64url');const text=encode({alg:'RS256',typ:'JWT',kid:publicKey.kid})+'.'+encode({iss:'https://token.actions.githubusercontent.com',aud:'videoq-maintenance-prod',sub:'repo:videoq-jp/videoq:environment:production-db-smoke',repository:'videoq-jp/videoq',repository_id:'1083911938',repository_owner_id:'349188820',ref:'refs/heads/main',ref_type:'branch',environment:'production-db-smoke',runner_environment:'github-hosted',event_name:'workflow_dispatch',workflow_ref:'videoq-jp/videoq/.github/workflows/operations.yml@refs/heads/main',sha:source,workflow_sha:source,run_id:run,run_attempt:String(attempt),iat:now,nbf:now,exp:now+300});return text+'.'+Buffer.from(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,Buffer.from(text))).toString('base64url');}
const bundle=await build({entryPoints:[resolve('infra/cloudflare-maintenance/worker.mjs')],bundle:true,format:'esm',platform:'neutral',external:['cloudflare:workers'],write:false});
const persist=await mkdtemp(join(tmpdir(),'videoq-maintenance-native-'));let mf;
try{
 mf=new Miniflare(convertV4MiniflareOptions({name:'maintenance',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-11-23',compatibilityFlags:['nodejs_compat'],durableObjects:{MAINTENANCE:{className:'MaintenanceCoordinator',useSQLite:true}},durableObjectsPersist:persist,bindings:{MAINTENANCE_ENABLED:'true'},outboundService:async request=>{
  const u=new URL(request.url);
  if(u.href==='https://token.actions.githubusercontent.com/.well-known/jwks')return Response.json({keys:[publicKey]});
  if(u.origin!=='https://api.github.com')return new Response('Unexpected fixture request',{status:500});
  if(u.pathname.endsWith('/git/ref/heads/main'))return Response.json({object:{sha:source}});
  const run=/\/actions\/runs\/(\d+)$/.exec(u.pathname)?.[1];
  if(run)return Response.json({id:Number(run),run_attempt:attempts.get(run),head_sha:source,head_branch:'main',status:'in_progress',path:'.github/workflows/operations.yml',repository:{id:1083911938}});
  if(u.pathname.endsWith('/actions/workflows/ci.yml/runs'))return Response.json({workflow_runs:[{id:900,head_repository:{id:1083911938},head_sha:source,head_branch:'main',event:'push',status:'completed',conclusion:'success',repository:{id:1083911938}}]});
  return new Response('Unexpected fixture request',{status:500});
 }}));
 const call=async(run,attempt,body)=>{const r=await mf.dispatchFetch('https://maintenance.invalid/v1/smoke',{method:'POST',headers:{authorization:'Bearer '+await token(run,attempt),'x-github-token':'fixture-read-token-with-no-authority','content-type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
 const one=await call('123',1,{action:'acquire',writersStopped:false});assert.equal(one.status,200,JSON.stringify(one));assert.equal(one.body.state,'running');const run=one.body.run;
 assert.equal((await call('123',1,{action:'save',key:'background-queues',value:{originalPaused:false}})).status,200);
 await mf.unsafeEvictDurableObject('maintenance','MaintenanceCoordinator',{name:'videoq-prod-db'});
 assert.deepEqual((await call('123',1,{action:'load',key:'background-queues'})).body,{value:{originalPaused:false}});
 assert.equal((await call('124',1,{action:'acquire',writersStopped:false})).body.error,'MAINTENANCE_BUSY');
 assert.equal((await call('123',1,{action:'fail'})).body.state,'failed');
 assert.equal((await call('123',1,{action:'release'})).body.error,'MAINTENANCE_COMPLETION_PROOF_REQUIRED');
 attempts.set('123',2);assert.equal((await call('123',2,{action:'acquire',writersStopped:false})).body.state,'running');
 assert.equal((await call('123',1,{action:'assert'})).body.error,'MAINTENANCE_OWNERSHIP_REQUIRED');
 assert.equal((await call('123',2,{action:'save',key:'background-queues',value:{originalPaused:true}})).body.error,'MAINTENANCE_PLAN_IMMUTABLE');
 assert.equal((await call('123',2,{action:'save',key:'operation-result',value:{version:1,kind:'smoke',run,source,syntheticCleanupComplete:true}})).status,200);
 assert.equal((await call('123',2,{action:'complete'})).body.state,'completed');
 assert.equal((await call('123',2,{action:'release'})).body.state,'released');
 assert.equal((await call('123',2,{action:'release'})).body.state,'released');
 assert.equal((await call('124',1,{action:'acquire',writersStopped:false})).body.state,'running');
 console.log('Native maintenance verification passed: RSA identity, DO eviction persistence, exclusion, immutable plans, failed-attempt recovery, stale-owner rejection and idempotent release.');
}finally{if(mf)await mf.dispose();await rm(persist,{recursive:true,force:true});}
