import { accountDeletionForbidden, accountDeletionVideoOutcome, accountDeletionDrainOutcome } from '../../domain/operations/worker-account-deletion';
import { adminRoleIncludes, adminBooleanRoleLogic } from '../../domain/identity/admin';
import { and, eq, sql } from 'drizzle-orm';
import { withDb } from '../../db/pool';
import { users, videos, jobExecutions as jobs, externalTasks } from '../../db/schema';
import { deleteVideoInTransaction } from './video-mutation-repository';
import type { Bindings } from '../../types/bindings';
import type { WorkerAccountDeletion } from '../contracts/worker-account-deletion';

/** The job fence, permanent ban and mutations share one locked transaction. */
export function createPostgresWorkerAccountDeletion(env: Bindings): WorkerAccountDeletion {
  return {
    step: grant => withDb(env, db => db.transaction(async tx => {
      const [job] = await tx.select({ id: jobs.jobId }).from(jobs).where(and(
        eq(jobs.jobId, grant.jobId), eq(jobs.jobType, 'delete_account_data'), eq(jobs.status, 'running'),
        eq(jobs.leaseToken, grant.leaseToken), sql`${jobs.leaseUntil}>now()`,
      )).for('update');
      if (!job) return { status: 'denied' as const };
      const [task] = await tx.select({ id: externalTasks.id }).from(externalTasks).where(and(
        eq(externalTasks.dedupeKey, `account-delete:${grant.userId}`), eq(externalTasks.kind, 'sqs_job'),
        sql`${externalTasks.payload}->'message'->>'type'='delete_account_data'`,
        sql`${externalTasks.payload}->'message'->>'job_id'=${grant.jobId}`,
        sql`${externalTasks.payload}->'message'->'payload'->>'user_id'=${grant.userId}`,
      ));
      if (!task) return { status: 'denied' as const };
      const [user] = await tx.select({ banned: users.banned, banExpires: users.banExpires, role: users.role }).from(users).where(eq(users.id, grant.userId)).for('update');
      if (user && accountDeletionForbidden({ banned: user.banned ?? false, noExpiry: user.banExpires === null, administrator: adminRoleIncludes(user.role, adminBooleanRoleLogic) }, { or: (...terms) => terms.some(Boolean), not: term => !term })) return { status: 'denied' as const };
      const [video] = await tx.select({ id: videos.id }).from(videos).where(eq(videos.userId, grant.userId)).orderBy(videos.id).limit(1);
      if (video) {
        const deleted = await deleteVideoInTransaction(tx, Number(video.id), grant.userId);
        return accountDeletionVideoOutcome(deleted.deleted);
      }
      // Vector tables have no FK. Both profiles must be cleaned even when the
      // user switched models or was removed by an earlier successful attempt.
      await tx.execute(sql`DELETE FROM scene_embeddings WHERE user_id=${grant.userId}`);
      await tx.execute(sql`DELETE FROM scene_embeddings_768 WHERE user_id=${grant.userId}`);
      await tx.execute(sql`DELETE FROM chat_logs WHERE user_id=${grant.userId}`);
      await tx.execute(sql`DELETE FROM video_courses WHERE user_id=${grant.userId}`);
      await tx.execute(sql`DELETE FROM tags WHERE user_id=${grant.userId}`);
      await tx.execute(sql`DELETE FROM apikey WHERE reference_id=${grant.userId}`);
      await tx.execute(sql`DELETE FROM lti_credentials WHERE payload->>'ownerUserId'=${grant.userId}
        OR payload->>'userId'=${grant.userId}
        OR payload->>'installationId' IN (SELECT id FROM lms_installations WHERE owner_user_id=${grant.userId})`);
      // Remaining owned rows use the canonical FK cascades, including sessions
      // and encrypted user credentials. Durable cleanup outbox rows are retained.
      await tx.delete(users).where(eq(users.id, grant.userId));
      return accountDeletionDrainOutcome(true, false);
    })),
  };
}
