import { expect } from 'vitest';
import type { createCourseService } from '../../src/features/courses/service';
import { createMemoryCourseRepository } from '../../src/persistence/memory/course-repository';
/** Shared by the real workflow and negative controls; assertions test behavior. */
export async function assertCourseNameWorkflow(factory: typeof createCourseService): Promise<void> {
  const repo = createMemoryCourseRepository({now:()=>new Date('2026-11-27')});
  const service = factory(repo);
  const course = (await service.createUserCourse('owner','  Lesson  ',''))!;
  expect(course.name).toBe('Lesson');
  for (const invalid of ['   ','x'.repeat(256),'x'+String.fromCharCode(0)+'y']) {
    await expect(service.createUserCourse('owner',invalid,'')).rejects.toMatchObject({kind:'validation'});
    await expect(service.updateUserCourse(course.id,'owner',{name:invalid})).rejects.toMatchObject({kind:'validation'});
    await expect(service.createUserCourseIdempotent('owner',invalid,'',{action:'create_course',key:'test',requestHash:'a'.repeat(64)})).rejects.toMatchObject({kind:'validation'});
  }
  await service.updateUserCourse(course.id,'owner',{name:'  Updated  '});
  expect((await service.getCourse(course.id,'owner'))!.name).toBe('Updated');
}
