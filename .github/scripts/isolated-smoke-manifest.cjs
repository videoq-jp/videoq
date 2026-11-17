// Read an existing owner-only manifest. Never create one, discover credentials,
// contact providers, or silently regenerate an expired/missing context.
const fs=require('node:fs'),path=require('node:path');
const {validateIsolatedSmokeManifest}=require('./isolated-smoke-target.cjs');
function loadIsolatedSmokeManifest(filename,{now=Date.now}={}){
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
  const manifest=JSON.parse(bytes.subarray(0,count).toString('utf8'));validateIsolatedSmokeManifest(manifest,now());return Object.freeze(manifest);
 }catch{throw Error('ISOLATED_SMOKE_PRIVATE_FILE_REQUIRED');}finally{if(fd!==undefined)fs.closeSync(fd);}
}
module.exports={loadIsolatedSmokeManifest};
