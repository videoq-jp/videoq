import {createCourseTagRepository} from '../../persistence/factory';
import {courseTagInput,checkCourseTags} from '../../shared/course-tags';
import type {z} from 'zod';
import type {Bindings} from '../../types/bindings';
import type {CourseTagScope} from '../../persistence/contracts/course-tag-repository';
export {courseTagInput} from '../../shared/course-tags';
export type {CourseTagScope} from '../../persistence/contracts/course-tag-repository';
export async function courseTags(env:Bindings,scope:CourseTagScope,input:z.infer<typeof courseTagInput>){
 checkCourseTags(scope,input);
 return (await createCourseTagRepository(env)).execute(scope,input);
}
