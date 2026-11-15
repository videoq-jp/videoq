import {createCourseRepository,createMembershipRepository} from '../persistence/factory';
import type {Bindings} from '../types/bindings';
import type {CourseInfoOptions,CourseReadOptions} from '../persistence/contracts/course-repository';
import type {CreationIdempotency} from '../persistence/contracts/creation-idempotency';
export type {CourseDetail,CourseListItem,CourseInfo} from '../persistence/contracts/course-repository';
export async function getCourseInfo(env:Bindings,id:number,owner:string,options:CourseInfoOptions){return (await createCourseRepository(env)).getInfo(id,owner,options);}
export async function getCourseDetail(env:Bindings,id:number,user:string,options:CourseReadOptions={}){return (await createCourseRepository(env)).getDetail(id,user,options);}
export async function getCourseDetailByShareSlug(env:Bindings,slug:string,options:CourseReadOptions={}){return (await createCourseRepository(env)).getShared(slug,options);}
export async function createCourse(env:Bindings,user:string,name:string,description:string,key?:CreationIdempotency){return (await createCourseRepository(env)).create(user,name,description,key);}
export async function updateCourse(env:Bindings,id:number,user:string,fields:{name?:string;description?:string}){return (await createCourseRepository(env)).update(id,user,fields);}
export async function deleteCourse(env:Bindings,id:number,user:string){return (await createCourseRepository(env)).delete(id,user);}
export async function reorderCourses(env:Bindings,user:string,ids:number[]){return (await createCourseRepository(env)).reorder(user,ids);}
export async function reorderVideos(env:Bindings,id:number,user:string,ids:number[]){return (await createMembershipRepository(env)).reorderVideos(id,user,ids);}
export async function courseOwnedBy(env:Bindings,id:number,user:string){return (await createCourseRepository(env)).ownedBy(id,user);}
export async function setShareSlug(env:Bindings,id:number,user:string,slug:string){return (await createCourseRepository(env)).setShareSlug(id,user,slug);}
export async function clearShareSlug(env:Bindings,id:number,user:string){return (await createCourseRepository(env)).clearShareSlug(id,user);}
export async function listCoursesPage(env:Bindings,user:string,limit:number,offset:number){return (await createCourseRepository(env)).listPage(user,limit,offset);}
