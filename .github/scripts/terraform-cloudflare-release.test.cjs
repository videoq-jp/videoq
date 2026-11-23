const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {releaseVersion}=require('./terraform-cloudflare-release.cjs');
const settings={bindings:[{name:'AUTH_SECRET',type:'secret_text'},{name:'STATE',type:'durable_object_namespace',class_name:'State',namespace_id:'existing-namespace'}]};
const config={compatibility_date:'2026-11-23',vars:{ENVIRONMENT:'production'},durable_objects:{bindings:[{name:'STATE',class_name:'State'}]},migrations:[{tag:'v1',new_sqlite_classes:['State']}]};
test('secrets inherit from the deployed version and Durable Objects retain their namespace',()=>{
 const value=releaseVersion(config,settings,'deployed-version','v1');
 assert.deepEqual(value.bindings.find(b=>b.name==='AUTH_SECRET'),{type:'inherit',name:'AUTH_SECRET',version_id:'deployed-version'});
 assert.equal(value.bindings.find(b=>b.name==='STATE').namespace_id,'existing-namespace');
 assert.equal(value.migrations,undefined);
});
test('unknown object migrations and accidental plaintext secrets are rejected',()=>{
 assert.throws(()=>releaseVersion(config,settings,'deployed-version','v2'),/MIGRATION_TAG/);
 assert.throws(()=>releaseVersion({...config,vars:{AUTH_SECRET:'unsafe'}},settings,'version','v1'),/PLAINTEXT/);
 assert.throws(()=>releaseVersion(config,{bindings:[]},'version','v1'),/DURABLE_OBJECT_MIGRATION/);
});
test('prebuilt JavaScript and static header modules are preserved without bundling',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cf-release-test-'));
 try {
  fs.mkdirSync(path.join(root,'worker'));fs.mkdirSync(path.join(root,'assets'));
  fs.writeFileSync(path.join(root,'worker','index.js'),'export default {}');
  fs.writeFileSync(path.join(root,'worker','index.js.map'),'not uploaded');
  fs.writeFileSync(path.join(root,'assets','_headers'),'/*\n  X-Test: yes');
  const value=releaseVersion({compatibility_date:'2026-11-23',main:path.join(root,'worker','index.js'),assets:{directory:path.join(root,'assets'),binding:'ASSETS',not_found_handling:'none'}},{bindings:[]},'version');
  assert.deepEqual(value.modules.map(m=>[m.name,m.content_type]),[['index.js','application/javascript+module'],['_headers','text/plain']]);
  assert.equal(value.assets.directory,path.join(root,'assets'));
  assert.deepEqual(value.assets.config,{not_found_handling:'none'});
  fs.symlinkSync(path.join(root,'assets','_headers'),path.join(root,'worker','link'));
  assert.throws(()=>releaseVersion({main:path.join(root,'worker','index.js')},{bindings:[]},'version'),/SYMLINK/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('cron observations reject malformed or duplicate schedules',()=>{
 const {crons}=require('../../infra/bin/read-worker-schedules.cjs');
 assert.deepEqual(crons({schedules:[{cron:'17 3 * * *'}]}),['17 3 * * *']);
 assert.throws(()=>crons({}),/INVALID_CRON/);
 assert.throws(()=>crons({schedules:[{cron:'17 3 * * *'},{cron:'17 3 * * *'}]}),/DUPLICATE_CRON/);
});
test('source maps are uploaded only when the trusted release configuration enables them',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cf-release-sourcemaps-'));
 try {
  fs.writeFileSync(path.join(root,'index.js'),'export default {}');
  const sourceMap=JSON.stringify({version:3,sources:['src/index.ts'],mappings:''});
  fs.writeFileSync(path.join(root,'index.js.map'),sourceMap);
  const config={main:path.join(root,'index.js'),upload_source_maps:true};
  const enabled=releaseVersion(config,{bindings:[]},'version');
  const map=enabled.modules.find(m=>m.name==='index.js.map');
  assert.equal(map.content_type,'application/source-map');
  assert.equal(Buffer.from(map.content_base64,'base64').toString(),sourceMap);
  const disabled=releaseVersion({...config,upload_source_maps:false},{bindings:[]},'version');
  assert.equal(disabled.modules.some(m=>m.name.endsWith('.map')),false);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
