// Transient operator metadata only. No tokens, SQL exports or customer rows.
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const {RESOURCE_STEPS,resourceDigest}=require('./d1-resource-journal.cjs');
const LIMIT=1024*1024;
async function createPrivateResourcePlans(directory){
 if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('PRIVATE_RESOURCE_DIRECTORY_REQUIRED');
 const root=await fs.realpath(directory),original=await fs.lstat(directory);
 if(original.isSymbolicLink()||!original.isDirectory()||(original.mode&0o777)!==0o700||original.uid!==process.getuid())throw Error('PRIVATE_RESOURCE_DIRECTORY_REQUIRED');
 async function checkedRoot(){const current=await fs.lstat(root);if(!current.isDirectory()||current.isSymbolicLink()||(current.mode&0o777)!==0o700||current.uid!==original.uid||current.ino!==original.ino||current.dev!==original.dev)throw Error('PRIVATE_RESOURCE_DIRECTORY_CHANGED');}
 function filename(step){if(!RESOURCE_STEPS.includes(step))throw Error('INVALID_RESOURCE_PLAN_STEP');return path.join(root,step+'.plan.json');}
 return{
  async load(step){
   const file=filename(step);await checkedRoot();let handle;
   try{handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if(error.code==='ENOENT')return null;throw Error('PRIVATE_RESOURCE_PLAN_UNAVAILABLE');}
   try{
    const before=await handle.stat();if(!before.isFile()||(before.mode&0o777)!==0o600||before.uid!==original.uid||before.size>LIMIT)throw Error('PRIVATE_RESOURCE_PLAN_UNSAFE');
    const buffer=Buffer.alloc(LIMIT+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0),after=await handle.stat();
    if(bytesRead!==before.size||bytesRead>LIMIT||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('PRIVATE_RESOURCE_PLAN_CHANGED');
    let value;try{value=JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));}catch{throw Error('PRIVATE_RESOURCE_PLAN_INVALID');}
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('PRIVATE_RESOURCE_PLAN_INVALID');
    await checkedRoot();return value;
   }finally{await handle.close();}
  },
  async save(step,value){
   const file=filename(step);await checkedRoot();
   if(!value||typeof value!=='object'||Array.isArray(value))throw Error('PRIVATE_RESOURCE_PLAN_INVALID');
   let data;try{data=JSON.stringify(value);}catch{throw Error('PRIVATE_RESOURCE_PLAN_INVALID');}
   if(Buffer.byteLength(data)>LIMIT)throw Error('PRIVATE_RESOURCE_PLAN_TOO_LARGE');
   let handle;try{handle=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch(error){throw Error(error.code==='EEXIST'?'PRIVATE_RESOURCE_PLAN_ALREADY_EXISTS':'PRIVATE_RESOURCE_PLAN_CREATE_REFUSED');}
   try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}
   const dir=await fs.open(root,constants.O_RDONLY);try{await dir.sync();}finally{await dir.close();}
   const stored=await this.load(step);if(resourceDigest(stored)!==resourceDigest(value))throw Error('PRIVATE_RESOURCE_PLAN_NOT_DURABLE');
  },
 };
}
module.exports={createPrivateResourcePlans};
