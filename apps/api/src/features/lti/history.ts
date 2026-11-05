import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { chatAnswerSchema } from "@videoq/trpc/chat";
import { withDb } from "../../db/pool";
import { chatLogs, ltiCredentials, videoCourseMembers } from "../../db/schema";
import type { Bindings } from "../../types/bindings";
import { digest, randomSecret, readCredential } from "./store";

type Scope = { registrationId: string; subjectHash: string; courseId: number };
const saved = z.object({ scopeVideoIds: z.array(z.number().int().positive()).max(1000), turns: z.array(z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/), logId: z.number().int().positive(), question: z.string().max(4000),
})).max(50) });
export const courseHistoryId = (scope: Scope) => digest(JSON.stringify(["lti-course-history-v1", scope.registrationId, scope.subjectHash, scope.courseId]));

/** Only server-issued completed log IDs are saved; namespaces isolate schools, learners and courses. */
export async function appendCourseHistory(env: Bindings, scope: Scope, question: string, logId: number | null, allowed: number[] | undefined) {
  if (logId === null) return;
  const id = await courseHistoryId(scope);
  await withDb(env, async db => {
    const members = allowed ?? (await db.select({ id: videoCourseMembers.videoId }).from(videoCourseMembers).where(eq(videoCourseMembers.courseId, scope.courseId))).map(row => row.id);
    const scopeJson = JSON.stringify([...new Set(members)].sort((a,b) => a-b));
    const turn = { id: randomSecret().slice(0, 32), logId, question };
    const expiresAt = new Date(Date.now() + 86400_000);
    // Atomic append protects simultaneous pages. A reduced permission scope drops
    // prior context instead of exposing answers from newly restricted videos.
    const previous = sql`CASE WHEN ${ltiCredentials.expiresAt} > now() AND (${ltiCredentials.payload}->'scopeVideoIds') <@ ${scopeJson}::jsonb
      THEN coalesce(${ltiCredentials.payload}->'turns', '[]'::jsonb) ELSE '[]'::jsonb END`;
    await db.insert(ltiCredentials).values({ id, kind: "lti-history", payload: { scopeVideoIds: JSON.parse(scopeJson) as number[], turns: [turn] }, expiresAt })
      .onConflictDoUpdate({ target: ltiCredentials.id, set: { expiresAt, payload: sql`jsonb_build_object('scopeVideoIds', ${scopeJson}::jsonb, 'turns',
        (SELECT jsonb_agg(item ORDER BY ord) FROM (SELECT item, ord FROM jsonb_array_elements((${previous}) || ${JSON.stringify([turn])}::jsonb)
          WITH ORDINALITY AS entries(item,ord) ORDER BY ord DESC LIMIT 50) recent))` } });
  });
}

export async function readCourseHistory(env: Bindings, scope: Scope, ownerUserId: string, videoIds: number[]) {
  const record = saved.safeParse(await readCredential(env, await courseHistoryId(scope), "lti-history"));
  if (!record.success || !record.data.scopeVideoIds.every(id => videoIds.includes(id)) || !record.data.turns.length) return [];
  const rows = await withDb(env, db => db.select({ id: chatLogs.id, answer: chatLogs.response, feedback: chatLogs.feedback }).from(chatLogs)
    .where(and(eq(chatLogs.userId, ownerUserId), eq(chatLogs.courseId, scope.courseId), inArray(chatLogs.id, record.data.turns.map(turn => turn.logId)))));
  return record.data.turns.flatMap(turn => {
    const row = rows.find(row => row.id === turn.logId);
    const answer = chatAnswerSchema.safeParse(row?.answer);
    if (!row || !answer.success || answer.data.sources.some(source => !videoIds.includes(source.video_id))) return [];
    return [{ ...turn, answer: answer.data, feedback: row.feedback === "good" || row.feedback === "bad" ? row.feedback : null }];
  });
}
