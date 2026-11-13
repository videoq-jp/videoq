import { and, eq, sql } from 'drizzle-orm';
import { withDb } from '../../src/db/pool';
import { lmsCourses, teachingConnections, users, videoCourses } from '../../src/db/schema';
import { syncLmsResource as synchronize, type LmsGrant } from '../../src/repositories/lms-resource-repository';
import type { Bindings } from '../../src/types/bindings';
import type { ResourceManifest } from '../../src/features/lms/resource';
/** Explicitly seed a teacher's connection for existing learning/management fixtures. */
export async function prepareTeacherFixture(env: Bindings, grant: LmsGrant & { ownerUserId: string }, contextId: string, name = 'LMS ' + contextId) {
  await withDb(env, db => db.transaction(async tx => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, grant.ownerUserId)).for('update');
    const [link] = await tx.select().from(teachingConnections).where(and(eq(teachingConnections.provider, 'moodle'),
      eq(teachingConnections.installationId, grant.id), eq(teachingConnections.contextId, contextId)));
    if (link) return;
    const [mapping] = await tx.select().from(lmsCourses).where(and(eq(lmsCourses.installationId, grant.id), eq(lmsCourses.contextId, contextId)));
    let courseId = mapping?.courseId;
    if (!courseId) {
      const [course] = await tx.insert(videoCourses).values({ userId: grant.ownerUserId, name, description: '',
        managedByLms: true, nativeAccessDisabled: true, displayOrder: sql`(SELECT COALESCE(MAX(display_order), -1) + 1 FROM video_courses WHERE user_id = ${grant.ownerUserId})`, createdAt: sql`now()`, updatedAt: sql`now()` }).returning({ id: videoCourses.id });
      courseId = course.id;
      await tx.insert(lmsCourses).values({ id: crypto.randomUUID(), installationId: grant.id, contextId, courseId });
    }
    await tx.insert(teachingConnections).values({ provider: 'moodle', installationId: grant.id, contextId,
      teacherSubject: 'fixture-teacher', ownerUserId: grant.ownerUserId, courseId });
  }));
}
export async function syncTeacherFixture(env: Bindings, grant: LmsGrant & { ownerUserId: string }, externalId: string, manifest: ResourceManifest) {
  await prepareTeacherFixture(env, grant, manifest.contextId, manifest.courseTitle);
  return synchronize(env, grant, externalId, manifest);
}
