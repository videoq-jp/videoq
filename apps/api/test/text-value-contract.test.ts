import { expect, it, vi } from 'vitest';
import { textValueFailure } from '@videoq/domain/text-value';
import { inputSchemas } from '@videoq/trpc/inputs';
import { managementToolSchemas } from '../src/tools/management';
import { createMemoryCourseRepository } from '../src/persistence/memory/course-repository';
import { createCourseService } from '../src/features/courses/service';
import { createVideoManagementService } from '../src/features/videos/management-service';
import type { VideoManagementDependencies } from '../src/features/videos/management-ports';
const nul = 'prefix' + String.fromCharCode(0) + 'suffix';
it.each(['日本語 😀', '  paragraphs\n\tremain  ', 'e\u0301', ''])('preserves valid text without normalization: %j', value => {
  expect(textValueFailure(value)).toBeNull();
  expect(inputSchemas['courses.create'].parse({name:'Lesson',description:value}).description).toBe(value);
});
it('rejects NUL descriptions through schemas and direct course workflows without mutation', async () => {
  expect(inputSchemas['courses.create'].safeParse({name:'Lesson',description:nul}).success).toBe(false);
  expect(inputSchemas['courses.update'].safeParse({id:1,description:nul}).success).toBe(false);
  expect(managementToolSchemas.create_course.safeParse({idempotency_key:'test-key-123',name:'Lesson',description:nul}).success).toBe(false);
  const repo = createMemoryCourseRepository({now:()=>new Date('2026-11-27')});
  const service = createCourseService(repo);
  await expect(service.createUserCourse('owner','Lesson',nul)).rejects.toMatchObject({kind:'validation'});
  await expect(service.createUserCourseIdempotent('owner','Lesson',nul,{action:'create_course',key:'key',requestHash:'a'.repeat(64)})).rejects.toMatchObject({kind:'validation'});
  expect((await repo.listPage('owner',20,0)).count).toBe(0);
  const course = (await service.createUserCourse('owner','Lesson','original'))!;
  await expect(service.updateUserCourse(course.id,'owner',{description:nul})).rejects.toMatchObject({kind:'validation'});
  expect(await service.updateUserCourse(course.id,'other',{description:nul})).toEqual({notFound:true});
  expect((await service.getCourse(course.id,'owner'))!.description).toBe('original');
});
it.each(['title','description','transcript'] as const)('rejects NUL video %s in schema and direct update before persistence', async field => {
  expect(inputSchemas['videos.update'].safeParse({id:1,[field]:nul}).success).toBe(false);
  const update = vi.fn(), deps = {ownedBy:vi.fn(async()=>true),update,validateTranscript:()=>null} as unknown as VideoManagementDependencies;
  expect(await createVideoManagementService(deps).patchUserVideo(1,'owner',{[field]:nul})).toHaveProperty(`fieldError.${field}`);
  expect(update).not.toHaveBeenCalled();
  vi.mocked(deps.ownedBy).mockResolvedValue(false);
  expect(await createVideoManagementService(deps).patchUserVideo(1,'other',{[field]:nul})).toEqual({notFound:true});
});
