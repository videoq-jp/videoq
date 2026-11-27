import { createUseCaseBus } from '../application/use-case-bus';
import { createCourseService } from '../features/courses/service';
import { createCourseRepository } from '../persistence/factory';
import type { Bindings } from '../types/bindings';

type Service = ReturnType<typeof createCourseService>;
export async function createCourseUseCases(env: Bindings) {
  return createUseCaseBus(createCourseService(await createCourseRepository(env)));
}
export async function getCourse(env: Bindings, ...args: Parameters<Service["getCourse"]>) {
  return (await createCourseUseCases(env)).execute("getCourse", ...args);
}
export async function getSharedCourse(env: Bindings, ...args: Parameters<Service["getSharedCourse"]>) {
  return (await createCourseUseCases(env)).execute("getSharedCourse", ...args);
}
export async function createUserCourse(env: Bindings, ...args: Parameters<Service["createUserCourse"]>) {
  return (await createCourseUseCases(env)).execute("createUserCourse", ...args);
}
export async function createUserCourseIdempotent(env: Bindings, ...args: Parameters<Service["createUserCourseIdempotent"]>) {
  return (await createCourseUseCases(env)).execute("createUserCourseIdempotent", ...args);
}
export async function saveShareLink(env: Bindings, ...args: Parameters<Service["saveShareLink"]>) {
  return (await createCourseUseCases(env)).execute("saveShareLink", ...args);
}
export async function listCourses(env: Bindings, ...args: Parameters<Service["listCourses"]>) {
  return (await createCourseUseCases(env)).execute("listCourses", ...args);
}
export async function updateUserCourse(env: Bindings, ...args: Parameters<Service["updateUserCourse"]>) {
  return (await createCourseUseCases(env)).execute("updateUserCourse", ...args);
}
export async function removeCourse(env: Bindings, ...args: Parameters<Service["removeCourse"]>) {
  return (await createCourseUseCases(env)).execute("removeCourse", ...args);
}
export async function reorderUserCourses(env: Bindings, ...args: Parameters<Service["reorderUserCourses"]>) {
  return (await createCourseUseCases(env)).execute("reorderUserCourses", ...args);
}
export async function clearShareLink(env: Bindings, ...args: Parameters<Service["clearShareLink"]>) {
  return (await createCourseUseCases(env)).execute("clearShareLink", ...args);
}
