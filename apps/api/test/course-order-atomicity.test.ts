import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeFakePgQuery,
  type MatchableSql,
  type PgQueryInput,
  type QueryCall,
} from "./helpers/pg-fake";

const calls: QueryCall[] = [];
let existingIdempotency: Record<string, unknown>[] = [];

vi.mock("pg", () => {
  class FakeClient {
    async connect() {}
    async end() {}
    async query(sqlOrConfig: PgQueryInput, args: unknown[] = []) {
      return executeFakePgQuery({
        calls,
        sqlOrConfig,
        args,
        rowsFor(sql: MatchableSql) {
          if (sql.includes("FROM \"mcp_idempotency_records\"")) {
            return existingIdempotency;
          }
          if (sql.includes("INSERT INTO video_courses")) return [{ id: 9 }];
          return [];
        },
      });
    }
  }
  return { default: { Client: FakeClient } };
});

import { createCourse } from "../src/repositories/course-repository";

beforeEach(() => {
  calls.splice(0);
  existingIdempotency = [];
});

describe("講座表示順の採番", () => {
  it("同じ所有者の作成をuser行ロックで直列化する", async () => {
    await expect(
      createCourse(
        { HYPERDRIVE: { connectionString: "postgres://fake/db" } } as never,
        "user-1",
        "course",
        "",
      ),
    ).resolves.toEqual({ ok: true, courseId: 9, reused: false });

    const lockIndex = calls.findIndex(
      (call) => call.sql.includes("FROM users") && call.sql.includes("FOR UPDATE"),
    );
    const insertIndex = calls.findIndex((call) => call.sql.includes("INSERT INTO video_courses"));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBeLessThan(insertIndex);
  });

  it("同じidempotency keyとpayloadなら既存講座を返してINSERTしない", async () => {
    existingIdempotency = [
      { requestHash: "a".repeat(64), resourceId: 77 },
    ];

    await expect(
      createCourse(
        { HYPERDRIVE: { connectionString: "postgres://fake/db" } } as never,
        "user-1",
        "course",
        "",
        {
          action: "create_course",
          key: "course-request-1",
          requestHash: "a".repeat(64),
        },
      ),
    ).resolves.toEqual({ ok: true, courseId: 77, reused: true });

    expect(calls.some((call) => call.sql.includes("INSERT INTO video_courses"))).toBe(
      false,
    );
  });
});
