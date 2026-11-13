import { and, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { withDb } from '../../db/pool';
import { teachingConnections, lmsInstallations, ltiCredentials, users, videoCourses } from '../../db/schema';
import { activeLmsOwner } from '../../repositories/lms-installation-repository';
import { classroomConfig, launchSchema } from '../classroom/config';
import { getContext } from '../classroom/client';
import { readAccount } from '../classroom/oauth';
import { decryptServerSecret } from '../../lib/secret-encryption';
import { ltiConfig } from '../lti/config';
import { MaterialsClient } from '../lms/connector-client';
import { ApiError } from '../../shared/errors';
import type { Bindings } from '../../types/bindings';
import { digest, putCredential, randomSecret } from '../lti/store';

export const ticketSchema = z.object({ provider: z.enum(['moodle', 'classroom']), installationId: z.string().min(1),
  contextId: z.string().min(1), teacherSubject: z.string().min(1), teacherName: z.string().max(512),
  title: z.string().max(255), returnUrl: z.url(),
  resourceLinkId: z.string().optional(),
  classroomProof: z.object({ accountEnvelope: z.string(), launch: launchSchema }).optional() }).strict();
export type TeachingTicket = z.infer<typeof ticketSchema>;
const denied = () => new ApiError(403, 'FORBIDDEN', 'The teaching connection is unavailable.');
export async function issueTeachingTicket(env: Bindings, input: TeachingTicket) {
  const ticket = randomSecret();
  await putCredential(env, await digest(ticket), 'teaching-connect', ticketSchema.parse(input), 600);
  const frontend = new URL(env.FRONTEND_URL);
  if (frontend.protocol !== 'https:') throw denied();
  return { url: frontend.origin + '/teaching/connect?ticket=' + ticket };
}
export async function teachingConnection(env: Bindings, provider: 'moodle' | 'classroom', installationId: string, contextId: string) {
  return withDb(env, async db => { const row = (await db.select({ link: teachingConnections, courseTitle: videoCourses.name }).from(teachingConnections)
    .innerJoin(users, eq(users.id, teachingConnections.ownerUserId))
    .innerJoin(videoCourses, and(eq(videoCourses.id, teachingConnections.courseId), eq(videoCourses.userId, teachingConnections.ownerUserId)))
    .where(and(eq(teachingConnections.provider, provider), eq(teachingConnections.installationId, installationId),
      eq(teachingConnections.contextId, contextId), eq(teachingConnections.active, true), activeLmsOwner())))[0]; return row ? { ...row.link, courseTitle: row.courseTitle } : null; });
}
export async function readTeachingTicket(env: Bindings, ticket: string) {
  const id = await digest(ticket);
  return withDb(env, async db => {
    const [record] = await db.select().from(ltiCredentials).where(and(eq(ltiCredentials.id, id),
      eq(ltiCredentials.kind, 'teaching-connect'), gt(ltiCredentials.expiresAt, new Date())));
    const input = ticketSchema.safeParse(record?.payload);
    if (!input.success) throw denied();
    return input.data;
  });
}
/** Owner first, then ticket and context: exactly one teacher can claim a class. */
export async function connectTeachingCourse(env: Bindings, ticket: string, ownerUserId: string, selectedCourseId?: number) {
  const authority = await readTeachingTicket(env, ticket);
  await verifyTeachingAuthority(env, authority);
  return withDb(env, db => db.transaction(async tx => {
    const [owner] = await tx.select({ id: users.id }).from(users)
      .where(and(eq(users.id, ownerUserId), activeLmsOwner())).for('update');
    if (!owner) throw denied();
    const ticketId = await digest(ticket);
    const [record] = await tx.select().from(ltiCredentials).where(and(eq(ltiCredentials.id, ticketId),
      eq(ltiCredentials.kind, 'teaching-connect'), gt(ltiCredentials.expiresAt, new Date()))).for('update');
    const parsed = ticketSchema.safeParse(record?.payload);if (!parsed.success) throw denied();
    const input = parsed.data;
    // Serialize different teachers' simultaneous attempts for the same context.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([input.provider,input.installationId,input.contextId])},0))`);
    const [existing] = await tx.select().from(teachingConnections).where(and(eq(teachingConnections.provider, input.provider),
      eq(teachingConnections.installationId, input.installationId), eq(teachingConnections.contextId, input.contextId))).for('update');
    if (existing && (existing.ownerUserId !== ownerUserId || existing.teacherSubject !== input.teacherSubject ||
      selectedCourseId !== undefined && existing.courseId !== selectedCourseId)) {
      throw new ApiError(409, 'CONFLICT', 'This class is already connected. Ask its owner to manage this connection.');
    }
    if (input.provider === 'moodle') {
      const [site] = await tx.select({ id: lmsInstallations.id }).from(lmsInstallations)
        .where(and(eq(lmsInstallations.id, input.installationId), eq(lmsInstallations.active, true))).for('share');
      if (!site || !input.resourceLinkId) throw denied();
    }
    const courseId = selectedCourseId ?? existing?.courseId;
    if (!courseId) throw denied();
    const [course] = await tx.select({ id: videoCourses.id }).from(videoCourses).where(and(
      eq(videoCourses.id, courseId), eq(videoCourses.userId, ownerUserId), eq(videoCourses.nativeAccessDisabled, false))).for('share');
    if (!course) throw denied();
    if (existing) await tx.update(teachingConnections).set({ active: true, resourceLinkId: input.resourceLinkId ?? null }).where(eq(teachingConnections.id, existing.id));
    else await tx.insert(teachingConnections).values({ provider: input.provider, installationId: input.installationId,
      contextId: input.contextId, teacherSubject: input.teacherSubject, ownerUserId, courseId, resourceLinkId: input.resourceLinkId });
    await tx.delete(ltiCredentials).where(eq(ltiCredentials.id, ticketId));
    return { returnUrl: input.returnUrl, courseId };
  }));
}

async function verifyTeachingAuthority(env: Bindings, input: TeachingTicket) {
  if (input.provider === 'classroom') {
    if (!classroomConfig(env) || !input.classroomProof || input.installationId !== env.CLASSROOM_CLIENT_ID) throw denied();
    const account = await readAccount(env, await decryptServerSecret(env, input.classroomProof.accountEnvelope, 'teaching-classroom'));
    if (account.subject !== input.teacherSubject || input.classroomProof.launch.courseId !== input.contextId) throw denied();
    const context = await getContext(input.classroomProof.launch, account.accessToken);
    if (!context.teacherContext) throw denied();
  } else {
    if (!ltiConfig(env)?.databaseRegistrations) throw denied();
    const site = await withDb(env, async db => (await db.select().from(lmsInstallations).where(and(
      eq(lmsInstallations.id, input.installationId), eq(lmsInstallations.active, true))))[0]);
    if (!site?.materialsService || !input.resourceLinkId) throw denied();
    const context = await new MaterialsClient(env, { ...site, materialsService: site.materialsService })
      .access(input.contextId, input.resourceLinkId, input.teacherSubject);
    if (!context.permissions?.manageContent) throw denied();
  }
}
