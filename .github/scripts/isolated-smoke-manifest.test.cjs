const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {loadIsolatedSmokeManifest:load}=require('./isolated-smoke-manifest.cjs');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'videoq-isolated-manifest-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const file=path.join(directory,'manifest.json'),manifest={version:1,nonce:'a'.repeat(16),databaseId:'11111111-2222-4333-8444-555555555555',workersSubdomain:'synthetic-account',issuedAt:1000,expiresAt:100000};fs.writeFileSync(file,JSON.stringify(manifest),{mode:0o600});return{directory,file,manifest};}
test('private manifest is loaded without creating or regenerating context and remains immutable',t=>{
 const f=fixture(t);assert.deepEqual(load(f.file,{now:()=>2000}),f.manifest);assert.ok(Object.isFrozen(load(f.file,{now:()=>2000})));
 fs.unlinkSync(f.file);assert.throws(()=>load(f.file,{now:()=>2000}),/PRIVATE_FILE_REQUIRED/);assert.deepEqual(fs.readdirSync(f.directory),[]);
});
test('symlink, hard link, public permissions or oversized manifest are refused',t=>{
 const f=fixture(t),linked=path.join(f.directory,'link');fs.symlinkSync(f.file,linked);assert.throws(()=>load(linked,{now:()=>2000}),/PRIVATE_FILE_REQUIRED/);fs.unlinkSync(linked);
 fs.linkSync(f.file,linked);assert.throws(()=>load(f.file,{now:()=>2000}),/PRIVATE_FILE_REQUIRED/);fs.unlinkSync(linked);
 fs.chmodSync(f.file,0o644);assert.throws(()=>load(f.file,{now:()=>2000}),/PRIVATE_FILE_REQUIRED/);fs.chmodSync(f.file,0o600);
 fs.chmodSync(f.directory,0o755);assert.throws(()=>load(f.file,{now:()=>2000}),/PRIVATE_FILE_REQUIRED/);fs.chmodSync(f.directory,0o700);
 fs.writeFileSync(f.file,' '.repeat(8193));assert.throws(()=>load(f.file,{now:()=>2000}),/PRIVATE_FILE_REQUIRED/);
});
test('expired, malformed and secret-bearing contexts are retained and never repaired',t=>{
 const f=fixture(t);for(const text of ['{malformed',JSON.stringify({...f.manifest,expiresAt:2000}),JSON.stringify({...f.manifest,apiToken:'must-not-be-stored'})]){fs.writeFileSync(f.file,text);assert.throws(()=>load(f.file,{now:()=>2000}),/PRIVATE_FILE_REQUIRED/);assert.equal(fs.readFileSync(f.file,'utf8'),text);}
});
