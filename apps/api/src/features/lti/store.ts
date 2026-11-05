import { and, eq, gt, lte, sql } from "drizzle-orm";
import { withDb } from "../../db/pool";
import { ltiCredentials } from "../../db/schema";
import type { Bindings } from "../../types/bindings";

export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
export function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
}
export async function putCredential(env: Bindings, secret: string, kind: string, payload: Record<string, unknown>, seconds: number) {
  await withDb(env, db => db.insert(ltiCredentials).values({
    id: secret, kind, payload, expiresAt: new Date(Date.now() + seconds * 1000),
  }));
}
export async function readCredential(env: Bindings, id: string, kind: string) {
  return withDb(env, async db => (await db.select().from(ltiCredentials).where(and(
    eq(ltiCredentials.id, id), eq(ltiCredentials.kind, kind), gt(ltiCredentials.expiresAt, new Date()),
  )).limit(1))[0]?.payload ?? null);
}
/** Remember every scope used by this session, without extending its expiry.
 * Atomic union prevents concurrent questions from forgetting a previously allowed video.
 */
export async function recordScopeVideos(env: Bindings, id: string, videoIds: number[]): Promise<number[] | null> {
  return withDb(env, async db => {
    const [row] = await db.update(ltiCredentials).set({
      payload: sql`jsonb_set(${ltiCredentials.payload}, '{scopeVideoIds}', (
        SELECT coalesce(jsonb_agg(DISTINCT item), '[]'::jsonb)
        FROM jsonb_array_elements(coalesce(${ltiCredentials.payload}->'scopeVideoIds', '[]'::jsonb) || ${JSON.stringify(videoIds)}::jsonb) AS item
      ))`,
    }).where(and(eq(ltiCredentials.id, id), eq(ltiCredentials.kind, "session"), gt(ltiCredentials.expiresAt, new Date())))
      .returning({ payload: ltiCredentials.payload });
    const ids = row?.payload.scopeVideoIds;
    return Array.isArray(ids) && ids.every(Number.isSafeInteger) ? ids as number[] : null;
  });
}

/** DELETE ... RETURNING ensures one concurrent exchange can consume a login. */
export async function consumeLogin(env: Bindings, id: string): Promise<boolean> {
  return consumeCredential(env, id, "login");
}

/** Atomically consume an expiring protocol credential, including Classroom OAuth state. */
export async function consumeCredential(env: Bindings, id: string, kind: string): Promise<boolean> {
  return withDb(env, async db => (await db.delete(ltiCredentials).where(and(
    eq(ltiCredentials.id, id), eq(ltiCredentials.kind, kind), gt(ltiCredentials.expiresAt, new Date()),
  )).returning({ id: ltiCredentials.id })).length === 1);
}
export async function pruneLtiCredentials(env: Bindings) {
  await withDb(env, db => db.delete(ltiCredentials).where(lte(ltiCredentials.expiresAt, new Date())));
}
