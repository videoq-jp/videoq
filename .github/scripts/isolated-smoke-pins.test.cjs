const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{createHash}=require('node:crypto');
const {resourceDigest}=require('./d1-resource-journal.cjs');
const {loadIsolatedSmokePins:load,validateIsolatedSmokePins:validate}=require('./isolated-smoke-manifest.cjs');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'videoq-isolated-pins-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const identityKey='a'.repeat(64),source='b'.repeat(40),manifest={version:1,nonce:'c'.repeat(16),databaseId:'11111111-2222-4333-8444-555555555555',workersSubdomain:'synthetic-account',issuedAt:1000,expiresAt:100000},value={version:1,nonce:manifest.nonce,source,manifestSha256:resourceDigest(manifest),imageDigest:'d'.repeat(64),versions:{media:'1',search:'2',account:'3'},secretSha256:{R2_ACCESS_KEY_ID:'e'.repeat(64),R2_SECRET_ACCESS_KEY:'f'.repeat(64),WORKER_INTERNAL_API_SECRET:'0'.repeat(64)},identitySha256:createHash('sha256').update(identityKey).digest('hex')},file=path.join(directory,'pins.json');fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});return{directory,file,value,context:{manifest,source,identityKey,now:()=>2000}};}
test('private runtime pins bind exact manifest, reviewed source, identity key and immutable version/digest maps',t=>{
 const f=fixture(t),value=load(f.file,f.context);assert.deepEqual(value,f.value);assert.ok(Object.isFrozen(value)&&Object.isFrozen(value.versions)&&Object.isFrozen(value.secretSha256));assert.equal(JSON.stringify(value).includes(f.context.identityKey),false);
});
test('changed source, manifest, key, latest qualifier or extra raw secret refuses pins',t=>{
 const f=fixture(t);for(const context of [{...f.context,source:'9'.repeat(40)},{...f.context,manifest:{...f.context.manifest,nonce:'8'.repeat(16)}},{...f.context,identityKey:'7'.repeat(64)}])assert.throws(()=>load(f.file,context),/PRIVATE_FILE_REQUIRED/);
 for(const patch of [{versions:{...f.value.versions,media:'$LATEST'}},{apiToken:'raw-not-allowed'},{secretSha256:{...f.value.secretSha256,extra:'f'.repeat(64)}}])assert.throws(()=>validate({...f.value,...patch},f.context),/PINS_REQUIRED/);
 assert.deepEqual(JSON.parse(fs.readFileSync(f.file,'utf8')),f.value);
});
test('missing, linked or public runtime pins are never accepted or regenerated',t=>{
 const f=fixture(t);fs.chmodSync(f.file,0o644);assert.throws(()=>load(f.file,f.context),/PRIVATE_FILE_REQUIRED/);fs.chmodSync(f.file,0o600);const linked=path.join(f.directory,'link');fs.linkSync(f.file,linked);assert.throws(()=>load(f.file,f.context),/PRIVATE_FILE_REQUIRED/);fs.unlinkSync(linked);fs.unlinkSync(f.file);assert.throws(()=>load(f.file,f.context),/PRIVATE_FILE_REQUIRED/);assert.deepEqual(fs.readdirSync(f.directory),[]);
});
