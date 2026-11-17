// Read an existing owner-only manifest. Never create one, discover credentials,
// contact providers, or silently regenerate an expired/missing context.
const fs=require('node:fs'),path=require('node:path');
const {validateIsolatedSmokeManifest}=require('./isolated-smoke-target.cjs');
const {createHash}=require('node:crypto');
const {resourceDigest}=require('./d1-resource-journal.cjs');
function loadPrivateRecord(filename,validate){
 if(typeof filename!=='string'||!path.isAbsolute(filename)||filename.includes('\0'))throw Error('ISOLATED_SMOKE_PRIVATE_FILE_REQUIRED');
 let fd;
 try{
  const parent=path.dirname(filename),root=fs.lstatSync(parent,{bigint:true});
  if(!root.isDirectory()||root.isSymbolicLink()||(root.mode&0o777n)!==0o700n||root.uid!==BigInt(process.getuid()))throw Error('directory');
  fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  const before=fs.fstatSync(fd,{bigint:true});
  if(!before.isFile()||(before.mode&0o777n)!==0o600n||before.uid!==root.uid||before.nlink!==1n||before.size>8192n)throw Error('file');
  const bytes=Buffer.alloc(8193),count=fs.readSync(fd,bytes,0,bytes.length,0),after=fs.fstatSync(fd,{bigint:true}),currentRoot=fs.lstatSync(parent,{bigint:true}),currentFile=fs.lstatSync(filename,{bigint:true});
  if(BigInt(count)!==before.size||['dev','ino','size','mtimeNs','ctimeNs','mode','uid','nlink'].some(k=>before[k]!==after[k])||['dev','ino','mode','uid'].some(k=>root[k]!==currentRoot[k])||currentFile.dev!==before.dev||currentFile.ino!==before.ino||currentFile.isSymbolicLink())throw Error('changed');
  const record=JSON.parse(bytes.subarray(0,count).toString('utf8'));validate(record);return Object.freeze(record);
 }catch{throw Error('ISOLATED_SMOKE_PRIVATE_FILE_REQUIRED');}finally{if(fd!==undefined)fs.closeSync(fd);}
}
function loadIsolatedSmokeManifest(filename,{now=Date.now}={}){return loadPrivateRecord(filename,value=>validateIsolatedSmokeManifest(value,now()));}
function validateIsolatedSmokePins(value,{manifest,source,identityKey,now=Date.now}){
 validateIsolatedSmokeManifest(manifest,now());
 const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),secretNames=['R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','WORKER_INTERNAL_API_SECRET'];
 if(!value||Object.keys(value).sort().join(',')!=='identitySha256,imageDigest,manifestSha256,nonce,secretSha256,source,version,versions'||value.version!==1||!/^[a-f0-9]{40}$/.test(source??'')||value.source!==source||value.nonce!==manifest.nonce||value.manifestSha256!==resourceDigest(manifest)||!hex(identityKey)||value.identitySha256!==createHash('sha256').update(identityKey).digest('hex')||!hex(value.imageDigest)||!value.versions||Object.keys(value.versions).sort().join(',')!=='account,media,search'||Object.values(value.versions).some(v=>typeof v!=='string'||!/^[1-9][0-9]{0,9}$/.test(v))||!value.secretSha256||Object.keys(value.secretSha256).sort().join(',')!==secretNames.join(',')||Object.values(value.secretSha256).some(v=>!hex(v)))throw Error('ISOLATED_SMOKE_PINS_REQUIRED');
 Object.freeze(value.versions);Object.freeze(value.secretSha256);return Object.freeze(value);
}
function loadIsolatedSmokePins(filename,context){return loadPrivateRecord(filename,value=>validateIsolatedSmokePins(value,context));}
module.exports={loadIsolatedSmokeManifest,loadIsolatedSmokePins,validateIsolatedSmokePins};
