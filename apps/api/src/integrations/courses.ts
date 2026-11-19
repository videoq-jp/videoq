import { createCourseService } from '../features/courses/service';
import { createCourseRepository } from '../persistence/factory';
import type { Bindings } from '../types/bindings';

type Service = ReturnType<typeof createCourseService>;
async function courseService(env: Bindings) {
  return createCourseService(await createCourseRepository(env));
}
export async function getCourse(env: Bindings, ...args: Parameters<Service["getCourse"]>) {
  return (await courseService(env)).getCourse(...args);
}
export async function getSharedCourse(env: Bindings, ...args: Parameters<Service["getSharedCourse"]>) {
  return (await courseService(env)).getSharedCourse(...args);
}
export async function createUserCourse(env: Bindings, ...args: Parameters<Service["createUserCourse"]>) {
  return (await courseService(env)).createUserCourse(...args);
}
export async function createUserCourseIdempotent(env: Bindings, ...args: Parameters<Service["createUserCourseIdempotent"]>) {
  return (await courseService(env)).createUserCourseIdempotent(...args);
}
export async function saveShareLink(env: Bindings, ...args: Parameters<Service["saveShareLink"]>) {
  return (await courseService(env)).saveShareLink(...args);
}
export async function listCourses(env: Bindings, ...args: Parameters<Service["listCourses"]>) {
  return (await courseService(env)).listCourses(...args);
}
export async function updateUserCourse(env: Bindings, ...args: Parameters<Service["updateUserCourse"]>) {
  return (await courseService(env)).updateUserCourse(...args);
}
export async function removeCourse(env: Bindings, ...args: Parameters<Service["removeCourse"]>) {
  return (await courseService(env)).removeCourse(...args);
}
export async function reorderUserCourses(env: Bindings, ...args: Parameters<Service["reorderUserCourses"]>) {
  return (await courseService(env)).reorderUserCourses(...args);
}
export async function clearShareLink(env: Bindings, ...args: Parameters<Service["clearShareLink"]>) {
  return (await courseService(env)).clearShareLink(...args);
}
