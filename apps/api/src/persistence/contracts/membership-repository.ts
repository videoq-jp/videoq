type TagMissing={notFound:'Video not found'|'Resource not found'};
type CourseMissing={notFound:'Course not found'|'Video not found'};
export interface MembershipRepository {
  reorderVideos(courseId:number,userId:string,videoIds:number[]):Promise<{notFound:true}|{mismatch:true}|{ok:true}>;
  attachTags(videoId:number,userId:string,tagIds:number[]):Promise<TagMissing|{added:number}>;
  detachTag(videoId:number,tagId:number,userId:string):Promise<TagMissing|{notFound:'Tag not found'}|{ok:true}>;
  addVideoToCourse(courseId:number,videoId:number,userId:string):Promise<CourseMissing|{alreadyIn:true;id:number}|{id:number}>;
  removeVideoFromCourse(courseId:number,videoId:number,userId:string):Promise<CourseMissing|{notMember:true}|{ok:true}>;
  addVideosBulk(courseId:number,videoIds:number[],userId:string):Promise<{notFound:'Course not found'|'Some videos not found'}|{added:number}>;
}
