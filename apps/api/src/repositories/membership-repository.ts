import {createVideoUploadRepository,createMembershipRepository} from '../persistence/factory';
import type {Bindings} from '../types/bindings';
export async function videoOwnedBy(env:Bindings,videoId:number,userId:string):Promise<boolean>{
  return (await (await createVideoUploadRepository(env)).getUploadState(videoId,userId)).found;
}
export async function attachTags(env:Bindings,videoId:number,userId:string,tagIds:number[]){return (await createMembershipRepository(env)).attachTags(videoId,userId,tagIds);}
export async function detachTag(env:Bindings,videoId:number,tagId:number,userId:string){return (await createMembershipRepository(env)).detachTag(videoId,tagId,userId);}
export async function addVideoToCourse(env:Bindings,courseId:number,videoId:number,userId:string){return (await createMembershipRepository(env)).addVideoToCourse(courseId,videoId,userId);}
export async function removeVideoFromCourse(env:Bindings,courseId:number,videoId:number,userId:string){return (await createMembershipRepository(env)).removeVideoFromCourse(courseId,videoId,userId);}
export async function addVideosBulk(env:Bindings,courseId:number,videoIds:number[],userId:string){return (await createMembershipRepository(env)).addVideosBulk(courseId,videoIds,userId);}
