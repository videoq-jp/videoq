import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { runtimeRateLimits as limits } from "../db/schema";
import { createHash } from "node:crypto";
import type pg from "pg";
import {
  pruneExpiredHistory,
  type ConsumeResult,
  type RateLimitBackend,
} from "../lib/rate-limit";

/** Row locks serialize the same key across replicas, including first use. */
export function postgresRateLimitBackend(pool: pg.Pool): RateLimitBackend {
  const db = drizzle(pool);
  const digest = (key: string) =>
    createHash("sha256").update(key).digest("hex");
  async function locked<T>(
    key: string,
    windowSec: number,
    update: (
      history: number[],
      now: number,
    ) => { history: number[]; result: T },
  ) {
    const client = await pool.connect();
    try {
      return await drizzle(client).transaction(async (tx) => {
        const hashed = digest(key);
        const [row] = await tx
          .insert(limits)
          .values({
            key: hashed,
            history: [],
            windowSec,
            expiresAt: sql`now()`,
          })
          .onConflictDoUpdate({ target: limits.key, set: { key: hashed } })
          .returning({
            history: limits.history,
            nowSec: sql<number>`EXTRACT(EPOCH FROM clock_timestamp())::float8`,
          });
        // Obtain the database clock only after the row lock is held.
        const now = row.nowSec;
        const { history, result } = update(
          pruneExpiredHistory(row.history, now, windowSec),
          now,
        );
        // Keep empty rows until expiry to serialize simultaneous first uses.
        await tx
          .update(limits)
          .set({
            history,
            windowSec,
            expiresAt: sql`to_timestamp(${(history[0] ?? now) + windowSec})`,
          })
          .where(eq(limits.key, hashed));
        return result;
      });
    } finally {
      client.release();
    }
  }

  const backend: RateLimitBackend = {
    async consume(key, limit, windowSec, cost = 1) {
      if (
        !Number.isSafeInteger(cost) ||
        cost < 1 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        !Number.isSafeInteger(windowSec) ||
        windowSec < 1
      )
        throw new Error("Invalid rate limit");
      return locked<ConsumeResult>(key, windowSec, (history, now) => {
        if (history.length + cost > limit) {
          const oldest = history.at(-1);
          return {
            history,
            result: {
              allowed: false,
              retryAfterSec:
                oldest === undefined
                  ? windowSec
                  : Math.max(1, Math.ceil(windowSec - (now - oldest))),
            },
          };
        }
        return {
          history: [...Array<number>(cost).fill(now), ...history],
          result: { allowed: true, retryAfterSec: 0 },
        };
      });
    },
    async release(key, windowSec, cost) {
      await locked(key, windowSec, (history) => ({
        history: history.slice(cost),
        result: undefined,
      }));
    },
    async snapshot(key) {
      const [row] = await db
        .select({
          history: limits.history,
          windowSec: limits.windowSec,
          nowSec: sql<number>`EXTRACT(EPOCH FROM clock_timestamp())::float8`,
        })
        .from(limits)
        .where(eq(limits.key, digest(key)));
      if (!row) return null;
      const history = pruneExpiredHistory(
        row.history,
        row.nowSec,
        row.windowSec,
      );
      return history.length
        ? { count: history.length, lastRequestMs: history[0] * 1000 }
        : null;
    },
    async record(key, windowSec) {
      await backend.consume(key, Number.MAX_SAFE_INTEGER, windowSec);
    },
  };
  return backend;
}
