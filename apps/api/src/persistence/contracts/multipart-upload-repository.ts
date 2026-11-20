import type { MultipartParts } from '../../application/multipart-upload';
export { UploadSessionError, type MultipartParts } from '../../application/multipart-upload';
export interface MultipartUploadRepository {
 initialize(videoId:number,userId:string,contentType:string):Promise<{part_size:number;part_count:number}>;
 partUrl(videoId:number,userId:string,partNumber:number):Promise<{upload_url:string}>;
 complete(videoId:number,userId:string,parts:MultipartParts):Promise<number|null>;
 hasUploadingFile(fileKey:string):Promise<boolean>;
 referencesFile(fileKey:string,uploadId?:string):Promise<boolean>;
}
