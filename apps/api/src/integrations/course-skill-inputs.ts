import { courseSkillInputService } from '../features/course-skills/input-service';
import { persistenceBackend } from '../persistence/backend';
import type { Bindings } from '../types/bindings';
import { armMaintenance } from '../lib/task-scheduler';
import type { CourseSkillSettings } from '../persistence/contracts/course-skill-input-repository';

export async function createCourseSkillInputRepository(env: Bindings) {
  if (persistenceBackend(env) === 'd1') {
    if (!env.DB) throw new Error('D1 DB binding is required');
    const { createD1CourseSkillInputRepository } = await import('../persistence/d1/course-skill-input-repository');
    return createD1CourseSkillInputRepository(env.DB);
  }
  const { createPostgresCourseSkillInputRepository } = await import('../persistence/postgres/course-skill-input-repository');
  return createPostgresCourseSkillInputRepository(env);
}
export async function createCourseSkillInputs(env: Bindings) {
  const service = courseSkillInputService({
    repository: await createCourseSkillInputRepository(env),
    hash: async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(v => v.toString(16).padStart(2, '0')).join(''),
    id: () => crypto.randomUUID(), now: () => Date.now(),
  });
  return { ...service, configure: async (courseId: number, ownerId: string, settings: CourseSkillSettings, forceGeneration = false) => {
    const applied = await service.configure(courseId, ownerId, settings, forceGeneration);
    if (applied && settings.generationEnabled) await armMaintenance(env, Date.now() + 60_000);
    return applied;
  } };
}

/** Durable periodic reconciliation recovers notifications lost after business commits. */
export async function reconcileCourseSkillInputs(env: Bindings) {
  return (await createCourseSkillInputs(env)).sweep();
}

/** Notifications accelerate durable polling; never fail an already committed business operation. */
export async function notifyCourseSkillInput(env: Bindings, courseId: number, ownerId: string): Promise<void> {
  // PostgreSQL uses the durable scan so ordinary video writes keep their single connection.
  if (persistenceBackend(env) !== 'd1') return;
  try {
    const result = await (await createCourseSkillInputs(env)).reconcile(courseId, ownerId);
    if (result.status !== 'disabled') await armMaintenance(env, Date.now() + 60_000);
  } catch { console.error(JSON.stringify({ event: 'course_skill_input_notification_failed', courseId })); }
}
export async function notifyVideoSkillInput(env: Bindings, videoId: number): Promise<void> {
  if (persistenceBackend(env) !== 'd1') return;
  try {
    const repository = await createCourseSkillInputRepository(env);
    for (const course of await repository.affected(videoId)) await notifyCourseSkillInput(env, Number(course.courseId), course.ownerId);
  } catch { console.error(JSON.stringify({ event: 'video_skill_input_notification_failed', videoId })); }
}
