import {constants} from 'node:fs';
import {open,rm} from 'node:fs/promises';

/** Validate and consume the same existing inode; never follow a replaced symlink. */
export async function openPrivateInput(path:string,maxBytes=5*1024**3,allowEmpty=false){
 let file;
 try{
  file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
  const info=await file.stat();
  if(!info.isFile()||(info.mode&0o077)!==0||info.uid!==process.getuid?.()||info.size<(allowEmpty?0:1)||info.size>maxBytes)throw new Error('Private bounded regular input is required.');
  return {file,info};
 }catch{await file?.close();throw new Error('Private bounded regular input is required.');}
}
export async function readPrivateInput(path:string,maxBytes:number){
 const {file,info}=await openPrivateInput(path,maxBytes);
 try{
  const chunks:Buffer[]=[];let total=0;const buffer=Buffer.alloc(64*1024);
  for(;;){const {bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>maxBytes)throw new Error('Private input exceeds its bound.');chunks.push(Buffer.from(buffer.subarray(0,bytesRead)));}
  if(total!==info.size)throw new Error('Private input changed during reading.');
  return Buffer.concat(chunks);
 }finally{await file.close();}
}
export async function copyPrivateInput(path:string,destination:string,maxBytes=5*1024**3){
 const {file,info}=await openPrivateInput(path,maxBytes,true);let created=false;
 try{
  const output=await open(destination,'wx',0o600);created=true;
  try{
   let total=0;const buffer=Buffer.alloc(64*1024);
   for(;;){const {bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>maxBytes)throw new Error('Private input exceeds its bound.');await output.writeFile(buffer.subarray(0,bytesRead));}
   if(total!==info.size)throw new Error('Private input changed during copying.');
   await output.sync();
  }finally{await output.close();}
 }catch(error){if(created)await rm(destination,{force:true});throw error;}
 finally{await file.close();}
}
