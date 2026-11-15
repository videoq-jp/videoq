const {test}=require('node:test'),assert=require('node:assert/strict');
const {createApiTrafficControl}=require('./cutover-api-traffic.cjs');
function fixture(){
 const scope={purpose:'isolated-rehearsal',nonce:'a'.repeat(16)};let version='11111111-2222-4333-8444-555555555555',deployment='11111111-2222-4333-8444-666666666666';
 const settings={bindings:[{name:'ENVIRONMENT',type:'plain_text',text:'production'},{name:'SECRET',type:'secret_text'},{name:'DB',type:'d1',id:'owned-db'}],compatibility_date:'2026-08-20'},writes=[];
 let split=false,unpublished=false,lost=false,safe=true,owned=true;
 const request=async(method,path,body)=>{if(method==='GET'){if(path.endsWith('/deployments'))return{deployments:[{id:deployment,versions:split?[{version_id:version,percentage:50},{version_id:deployment,percentage:50}]:[{version_id:version,percentage:100}]}]};if(path.endsWith('/versions?per_page=1'))return{items:[{id:unpublished?deployment:version}]};assert.ok(path.endsWith('/settings'));return structuredClone(settings);}
 assert.equal(method,'PATCH');assert.ok(path.endsWith('/settings'));writes.push(body);settings.bindings=body.bindings.map(b=>b.type==='inherit'?settings.bindings.find(x=>x.name===b.name):b);if(lost){lost=false;throw Error('lost response');}return{};};
 const control=createApiTrafficControl(request,{sleep:async()=>{},assertOwnership:async()=>{if(!owned)throw Error('lost ownership');},assertRestoreSafe:async()=>{if(!safe)throw Error('unverified handoff');}});
 return{scope,settings,writes,control,request,set version(v){version=v;},set split(v){split=v;},set unpublished(v){unpublished=v;},set lost(v){lost=v;},set safe(v){safe=v;},set owned(v){owned=v;}};
}
test('pause/restore preserve every other binding without secret values and are idempotent',async()=>{
 const f=fixture(),p=await f.control.prepare(f.scope);assert.equal(JSON.stringify(p).includes('owned-db'),false);assert.equal((await f.control.change(p,true)).trafficPaused,true);await f.control.change(p,true);assert.equal(f.writes.length,1);
 assert.ok(f.writes[0].bindings.filter(b=>b.name!=='MIGRATION_TRAFFIC_STATE').every(b=>b.type==='inherit'&&Object.keys(b).length===2));assert.equal((await f.control.change(p,false)).originalTrafficRestored,true);assert.equal(f.settings.bindings.some(b=>b.name==='SECRET'),true);assert.equal(f.writes.length,2);
});
test('original running flag is restored explicitly',async()=>{const f=fixture();f.settings.bindings.push({name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'running'});const p=await f.control.prepare(f.scope);await f.control.change(p,true);await f.control.change(p,false);assert.equal(f.settings.bindings.find(b=>b.name==='MIGRATION_TRAFFIC_STATE').text,'running');});
test('default ownership and default restore handoff refuse mutation',async()=>{
 const f=fixture(),p=await f.control.prepare(f.scope);await assert.rejects(createApiTrafficControl(f.request).change(p,true),/OWNERSHIP/);await f.control.change(p,true);await assert.rejects(createApiTrafficControl(f.request,{assertOwnership:async()=>{}}).change(p,false),/HANDOFF/);assert.equal(f.writes.length,1);
});
test('split deployments, unpublished latest versions and already paused services cannot be prepared',async()=>{
 for(const mutate of [f=>f.split=true,f=>f.unpublished=true,f=>f.settings.bindings.push({name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'paused'})]){const f=fixture();mutate(f);await assert.rejects(f.control.prepare(f.scope));assert.equal(f.writes.length,0);}
});
test('binding/runtime/flag drift and duplicate binding names fail before mutation',async()=>{
 for(const mutate of [f=>f.settings.bindings[2].id='replacement',f=>f.settings.compatibility_date='2026-11-16',f=>f.settings.bindings.push({name:'MIGRATION_TRAFFIC_STATE',type:'plain_text',text:'other'}),f=>f.settings.bindings.push({name:'SECRET',type:'secret_text'})]){const f=fixture(),p=await f.control.prepare(f.scope);mutate(f);await assert.rejects(f.control.change(p,true));assert.equal(f.writes.length,0);}
});
test('lost accepted response reconciles without reverting or applying a second update',async()=>{const f=fixture(),p=await f.control.prepare(f.scope);f.lost=true;assert.equal((await f.control.change(p,true)).trafficPaused,true);await f.control.change(p,true);assert.equal(f.writes.length,1);});
test('ownership loss, unverified restore and invalid target plans cannot write',async()=>{
 const f=fixture(),p=await f.control.prepare(f.scope);f.owned=false;await assert.rejects(f.control.change(p,true));f.owned=true;await f.control.change(p,true);f.safe=false;await assert.rejects(f.control.change(p,false));const changed={...p,worker:'another-worker'};await assert.rejects(f.control.change(changed,true));assert.equal(f.writes.length,1);
});
test('Cloudflare transport uses fixed HTTPS multipart settings and refuses other targets/methods',async()=>{
 const {createCloudflareTrafficTransport}=require('./cutover-api-traffic.cjs');const calls=[];
 const send=createCloudflareTrafficTransport('synthetic-token-0123456789',{fetcher:async(url,options)=>{calls.push({url,options});return Response.json({success:true,result:{ok:true}});}});
 const base='accounts/12daec56fdba43f677f2766ee26a5a39/workers/scripts/videoq-api/';await send('PATCH',base+'settings',{bindings:[]});assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.headers['content-type'],undefined);assert.ok(calls[0].options.body instanceof FormData);assert.deepEqual(JSON.parse(await calls[0].options.body.get('settings').text()),{bindings:[]});await send('GET',base+'versions?per_page=1');
 for(const [method,path] of [['DELETE',base+'settings'],['PATCH',base+'deployments'],['GET',base.replace('videoq-api','other')+'settings'],['GET','https://evil.invalid']])await assert.rejects(send(method,path),/REQUEST/);assert.equal(calls.length,2);
});
test('Cloudflare errors are sanitized and oversized responses are rejected',async()=>{
 const {createCloudflareTrafficTransport}=require('./cutover-api-traffic.cjs'),path='accounts/12daec56fdba43f677f2766ee26a5a39/workers/scripts/videoq-api/settings';
 for(const response of [new Response('private response',{status:403}),Response.json({success:false,errors:[{message:'private response'}]}),new Response('x'.repeat(1024*1024+1)),new Response('invalid json')]){const send=createCloudflareTrafficTransport('synthetic-token-0123456789',{fetcher:async()=>response});await assert.rejects(send('GET',path),error=>!error.message.includes('private response')&&/API_TRAFFIC_/.test(error.message));}
});

test('a different active code version after plan preparation cannot enter pause',async()=>{const f=fixture(),p=await f.control.prepare(f.scope);f.version='11111111-2222-4333-8444-777777777777';await assert.rejects(f.control.change(p,true),/CODE_VERSION_CHANGED/);assert.equal(f.writes.length,0);});

test('metadata propagation is re-observed without any patch or bypass of version consistency',async()=>{const f=fixture();let reads=0;const control=createApiTrafficControl(async(...args)=>{const result=await f.request(...args);if(args[1].endsWith('/versions?per_page=1')&&++reads<3)return{items:[{id:'11111111-2222-4333-8444-999999999999'}]};return result;},{sleep:async()=>{}});await control.prepare(f.scope);assert.equal(reads,3);assert.equal(f.writes.length,0);});
