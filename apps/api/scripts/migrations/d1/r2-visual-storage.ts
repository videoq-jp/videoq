import {isSafeMediaPath} from '../../../src/shared/media-path';
import type {R2Bucket} from '@cloudflare/workers-types';
import type {VisualMigrationDestination} from './copy-visual-artifacts';
import {VisualArtifactError} from './visual-artifacts';
/** R2 binding adapter; never replace an object at an existing immutable key. */
const objectKey=(key:string)=>{if(!isSafeMediaPath(key))throw new VisualArtifactError('Invalid visual storage path.');return 'media/'+key;};
export function r2VisualMigrationStorage(bucket:R2Bucket):VisualMigrationDestination{
 return {
  async read(key,maximumBytes){
   if(!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>16*1024*1024)throw new VisualArtifactError('Invalid visual object read budget.');
   const object=await bucket.get(objectKey(key));if(!object)return null;
   if(object.size>maximumBytes){await object.body.cancel();throw new VisualArtifactError('Visual object exceeds read budget.');}
   const reader=object.body.getReader(),parts:Uint8Array[]=[];let size=0;
   try{while(true){const part=await reader.read();if(part.done)break;const value:unknown=part.value;if(!(value instanceof Uint8Array))throw new VisualArtifactError('Invalid visual object body.');size+=value.byteLength;if(size>maximumBytes||size>object.size){await reader.cancel();throw new VisualArtifactError('Visual object exceeds declared size.');}parts.push(value);}}
   finally{reader.releaseLock();}
   if(size!==object.size)throw new VisualArtifactError('Visual object size mismatch.');
   const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}return bytes;
  },
  async create(key,bytes){
   const stored=await bucket.put(objectKey(key),bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:key.endsWith('.json')?'application/json':'application/octet-stream'}});
   if(!stored)throw new VisualArtifactError('Visual destination key already exists.');
  },
 };
}
