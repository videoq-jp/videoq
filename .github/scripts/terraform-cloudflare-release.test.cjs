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
