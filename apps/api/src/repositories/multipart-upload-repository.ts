import type {Bindings} from '../types/bindings';
import {createMultipartUploadRepository} from '../persistence/factory';
import type {MultipartParts} from '../persistence/contracts/multipart-upload-repository';
export {UploadSessionError} from '../persistence/contracts/multipart-upload-repository';
export async function initializeMultipartUpload(env:Bindings,id:number,user:string,type:string){return (await createMultipartUploadRepository(env)).initialize(id,user,type);}
export async function getMultipartUploadPartUrl(env:Bindings,id:number,user:string,part:number){return (await createMultipartUploadRepository(env)).partUrl(id,user,part);}
export async function completeMultipartVideoUpload(env:Bindings,id:number,user:string,parts:MultipartParts){return (await createMultipartUploadRepository(env)).complete(id,user,parts);}
