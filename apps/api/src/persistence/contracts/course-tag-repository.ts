import type { CourseTagCommand, CourseTagScope, CourseTagCatalog } from '../../application/course-tags';
export type { CourseTagScope, CourseTag, CourseTagCatalog } from '../../application/course-tags';
export interface CourseTagRepository{execute(scope:CourseTagScope,input:CourseTagCommand):Promise<CourseTagCatalog>;}
