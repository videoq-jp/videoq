import { expect, it } from "vitest";
import { getCurrentUser, setSearchApiKey, getSearchApiKeyStatus } from "../../src/repositories/user-repository";
import { pingPersistence } from "../../src/persistence/factory";
import type { Bindings } from "../../src/types/bindings";
import { createD1Fixture } from "./d1-fixture";

it("routes account operations to D1 and normalizes quota values and UTC months", async () => {
  const { database, dispose } = await createD1Fixture();
  const env = { DEPLOYMENT_EDITION: "cloud", DB: database, DATABASE_URL: "postgresql://unused" } as Bindings;
  try {
    expect(await pingPersistence(env)).toBe(true);
    expect(await getCurrentUser(env, "missing")).toBeNull();
    await database.prepare(`INSERT INTO users
      (id,username,email,role,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes,
       storage_limit_gb,processing_limit_minutes,ai_answers_limit,monthly_upload_limit_gb,used_upload_bytes,upload_usage_period_start)
      VALUES ('owner','owner','owner@example.test','user,admin',0,3,60,42,1.5,90,NULL,NULL,123,
        strftime('%Y-%m-%dT%H:%M:%fZ','now','start of month'))`).run();
    const user = await getCurrentUser(env, "owner");
    expect(user).toMatchObject({
      id: "owner", is_admin: true, is_over_quota: false, video_count: 0,
      used_upload_bytes: 123, used_storage_bytes: 42, storage_limit_bytes: 1.5 * 1024 ** 3,
      processing_limit_seconds: 5400, monthly_upload_limit_bytes: null, ai_answers_limit: null,
    });
    expect(user?.upload_resets_at).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
    await database.prepare("UPDATE users SET upload_usage_period_start='2000-01-01T00:00:00.000Z' WHERE id='owner'").run();
    expect((await getCurrentUser(env, "owner"))?.used_upload_bytes).toBe(0);
    expect(await setSearchApiKey(env, "owner", "test-ciphertext")).toBe(true);
    expect(await getSearchApiKeyStatus(env, "owner")).toBe(true);
  } finally { await dispose(); }
}, 20_000);
