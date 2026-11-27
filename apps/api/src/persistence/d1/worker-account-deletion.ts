import { adminRoleIncludes } from '../../domain/identity/admin';
import { adminD1RoleLogic } from '../admin-policy-sql';
import {
  and,
  eq,
  exists,
  notExists,
  not,
  or,
  isNull,
  inArray,
  sql,
} from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { insertSelectFields, runD1Batch } from "../../db/d1/query-builders";
import {
  users,
  videos,
  jobExecutions as jobs,
  externalTasks,
  chatLogs,
  courseEvaluationSnapshots,
  videoCourses,
  tags,
  apikey,
  ltiCredentials,
  lmsInstallations,
  mutationReceipts as receipts,
} from "../../db/schema/sqlite";
import {
  accountDeletionForbidden,
  accountDeletionVideoOutcome,
  accountDeletionDrainOutcome,
} from "../../domain/operations/worker-account-deletion";
import type {
  AccountDeletionLease,
  WorkerAccountDeletion,
} from "../contracts/worker-account-deletion";
import { createD1VideoMutationRepository } from "./video-mutation-repository";

/** Every cleanup batch rechecks the live job lease and permanent user ban. */
export function createD1WorkerAccountDeletion(
  database: D1Database,
  notify: () => Promise<void>,
): WorkerAccountDeletion {
  const db = createD1Connection(database);
  const authorization = (g: AccountDeletionLease) =>
    and(
      exists(
        db
          .select({ id: jobs.jobId })
          .from(jobs)
          .innerJoin(
            externalTasks,
            eq(externalTasks.dedupeKey, `account-delete:${g.userId}`),
          )
          .where(
            and(
              eq(jobs.jobId, g.jobId),
              eq(jobs.jobType, "delete_account_data"),
              eq(jobs.status, "running"),
              eq(jobs.leaseToken, g.leaseToken),
              sql`julianday(${jobs.leaseUntil})>julianday('now')`,
              eq(externalTasks.kind, "sqs_job"),
              sql`json_extract(${externalTasks.payload},'$.message.type')='delete_account_data'`,
              sql`json_extract(${externalTasks.payload},'$.message.job_id')=${jobs.jobId}`,
              sql`json_extract(${externalTasks.payload},'$.message.payload.user_id')=${g.userId}`,
            ),
          ),
      ),
      notExists(
        db
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.id, g.userId),
              accountDeletionForbidden(
                {
                  banned: sql`coalesce(${users.banned},0)=1`,
                  noExpiry: isNull(users.banExpires),
                  administrator: adminRoleIncludes(users.role, adminD1RoleLogic),
                },
                { or: (...terms) => or(...terms)!, not },
              ),
            ),
          ),
      ),
    )!;
  return {
    async step(grant) {
      const fence = authorization(grant);
      const live = await db
        .select({ id: jobs.jobId })
        .from(jobs)
        .where(and(eq(jobs.jobId, grant.jobId), fence))
        .get();
      if (!live) return { status: "denied" };
      const video = await db
        .select({ id: videos.id })
        .from(videos)
        .where(eq(videos.userId, grant.userId))
        .orderBy(videos.id)
        .limit(1)
        .get();
      if (video) {
        const result = await createD1VideoMutationRepository(
          database,
          notify,
          fence,
        ).delete(video.id, grant.userId);
        return accountDeletionVideoOutcome(result.deleted);
      }
      const token = crypto.randomUUID();
      const gate = exists(
        db
          .select({ token: receipts.token })
          .from(receipts)
          .where(eq(receipts.token, token)),
      );
      const ownedTables = [
        chatLogs,
        courseEvaluationSnapshots,
        videoCourses,
        tags,
      ] as const;
      const credentialOwner = or(
        sql`json_extract(${ltiCredentials.payload},'$.ownerUserId')=${grant.userId}`,
        sql`json_extract(${ltiCredentials.payload},'$.userId')=${grant.userId}`,
        inArray(
          sql<string>`json_extract(${ltiCredentials.payload},'$.installationId')`,
          db
            .select({ id: lmsInstallations.id })
            .from(lmsInstallations)
            .where(eq(lmsInstallations.ownerUserId, grant.userId)),
        ),
      )!;
      const noVideos = notExists(
        db
          .select({ id: videos.id })
          .from(videos)
          .where(eq(videos.userId, grant.userId)),
      );
      const results = await runD1Batch(database, [
        db.insert(receipts).select(
          db
            .select(
              insertSelectFields(receipts, {
                token: sql`${token}`,
                kind: sql`'account_delete'`,
                resourceId: sql`0`,
              }),
            )
            .from(jobs)
            .where(and(eq(jobs.jobId, grant.jobId), fence, noVideos)),
        ),
        ...ownedTables.map((table) =>
          db
            .delete(table)
            .where(
              and(
                inArray(
                  table.id,
                  db
                    .select({ id: table.id })
                    .from(table)
                    .where(eq(table.userId, grant.userId))
                    .orderBy(table.id)
                    .limit(100),
                ),
                gate,
              ),
            ),
        ),
        db
          .delete(apikey)
          .where(
            and(
              inArray(
                apikey.id,
                db
                  .select({ id: apikey.id })
                  .from(apikey)
                  .where(eq(apikey.referenceId, grant.userId))
                  .orderBy(apikey.id)
                  .limit(100),
              ),
              gate,
            ),
          ),
        db
          .delete(ltiCredentials)
          .where(
            and(
              inArray(
                ltiCredentials.id,
                db
                  .select({ id: ltiCredentials.id })
                  .from(ltiCredentials)
                  .where(credentialOwner)
                  .orderBy(ltiCredentials.id)
                  .limit(100),
              ),
              gate,
            ),
          ),
        db
          .delete(users)
          .where(
            and(
              eq(users.id, grant.userId),
              gate,
              noVideos,
              ...ownedTables.map((table) =>
                notExists(
                  db
                    .select({ id: table.id })
                    .from(table)
                    .where(eq(table.userId, grant.userId)),
                ),
              ),
              notExists(
                db
                  .select({ id: apikey.id })
                  .from(apikey)
                  .where(eq(apikey.referenceId, grant.userId)),
              ),
              notExists(
                db
                  .select({ id: ltiCredentials.id })
                  .from(ltiCredentials)
                  .where(credentialOwner),
              ),
            ),
          ),
        db
          .select({
            allowed: gate.as("allowed"),
            remaining: exists(
              db
                .select({ id: users.id })
                .from(users)
                .where(eq(users.id, grant.userId)),
            ).as("remaining"),
          })
          .from(jobs)
          .where(eq(jobs.jobId, grant.jobId)),
        db.delete(receipts).where(eq(receipts.token, token)),
      ]);
      const state = results[8].results[0];
      const outcome = accountDeletionDrainOutcome(
        Boolean(state?.allowed),
        Boolean(state?.remaining),
      );
      if (outcome.status !== "denied") await notify();
      return outcome;
    },
  };
}
