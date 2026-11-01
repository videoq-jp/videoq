import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { nodeBindings } from "../src/runtime/node-config";
import { postgresRateLimitBackend } from "../src/runtime/postgres-rate-limit";
import { provisionOnpremUser } from "../src/features/admin/onprem-users";
import type { Bindings } from "../src/types/bindings";

const databaseURL = process.env.QUOTA_TEST_DATABASE_URL;
const withPostgres = databaseURL ? describe : describe.skip;

withPostgres("on-prem account lifecycle without SaaS services", () => {
  const origin = "https://edition.example.test";
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `onprem_edition_${suffix}`;
  let control: pg.Client;
  const app = createApp();
  let env: Bindings;
  let pool: pg.Pool;
  let tearingDown = false;
  const idleErrors: Error[] = [];
  beforeAll(async () => {
    // Other API suites intentionally create partial schemas in the control DB.
    // Run this full account lifecycle against its own migrated database.
    control = new pg.Client({ connectionString: databaseURL });
    await control.connect();
    await control.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(databaseURL!);
    url.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 6 });
    pool.on("error", (error) => {
      // pg's pool.end() can resolve before an idle socket fully closes. The
      // forced test-DB drop can then report its expected termination event.
      if (tearingDown && "code" in error && error.code === "57P01") return;
      idleErrors.push(error);
    });
    await migrate(drizzle(pool), { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
    env = nodeBindings({ DATABASE_URL: url.toString(), BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: "a".repeat(48), USER_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64url"),
      R2_ACCESS_KEY_ID: "test", R2_SECRET_ACCESS_KEY: "test", R2_S3_ENDPOINT: "https://storage.example.test",
      R2_BUCKET_NAME: "test", SQS_QUEUE_URL: "http://queue.example.test/test", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test",
      // Accidentally retained SaaS keys must never re-enable the on-prem features.
      STRIPE_SECRET_KEY: "sk_test_stale", STRIPE_WEBHOOK_SECRET: "stale", GOOGLE_CLIENT_ID: "stale", GOOGLE_CLIENT_SECRET: "stale", MAILGUN_API_KEY: "stale",
    });
    env.DATABASE_POOL = pool;
    env.RATE_LIMIT_BACKEND = postgresRateLimitBackend(pool);
  }, 30_000);
  afterAll(async () => {
    try {
      tearingDown = true;
      await pool?.end();
      await control?.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      expect(idleErrors).toEqual([]);
    } finally { await control?.end(); vi.restoreAllMocks(); }
  });
  const post = (path: string, body: unknown, cookie?: string) => app.request(`${origin}${path}`, {
    method: "POST", headers: { "content-type": "application/json", Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  }, env);
  const token = (url: string) => new URL(url).pathname.split("/").at(-1)!;
  const cookieOf = (response: Response) => response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");

  it("supports operator bootstrap, admin-issued accounts and single-use activation while rejecting SaaS APIs", async () => {
    const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("external HTTP is disabled in acceptance"));
    const bootstrap = await provisionOnpremUser(env, { email: `admin-${suffix}@example.invalid`, username: `admin_${suffix}`, admin: true });
    const password = "Onprem-test-password-2026!";
    expect((await post("/api/auth/reset-password", { token: token(bootstrap.activation_url), newPassword: password })).status).toBe(200);
    expect((await post("/api/auth/reset-password", { token: token(bootstrap.activation_url), newPassword: password })).status).toBe(400);
    const signedIn = await post("/api/auth/sign-in/username", { username: bootstrap.username, password });
    expect(signedIn.status).toBe(200);
    const adminCookie = cookieOf(signedIn);
    expect(adminCookie).not.toBe("");
    const createInput = { email: `user-${suffix}@example.invalid`, username: `user_${suffix}` };
    expect((await post("/api/trpc/admin.createUser", createInput)).status).toBe(401);
    const created = await post("/api/trpc/admin.createUser", createInput, adminCookie);
    expect(created.status, await created.clone().text()).toBe(200);
    const user = (await created.json()).result.data;
    expect((await pool.query("SELECT role, quota_source, ai_answers_limit, processing_limit_minutes, storage_limit_gb, monthly_upload_limit_gb FROM users WHERE id=$1", [user.id])).rows[0]).toEqual({
      role: "user", quota_source: "admin", ai_answers_limit: null, processing_limit_minutes: null, storage_limit_gb: null, monthly_upload_limit_gb: null,
    });
    // Each HTTP request creates its own auth instance and PostgreSQL client.
    // Only one of two competing passwords may consume this activation token.
    const passwords = [password, "Competing-onprem-password-2026!"];
    const activations = await Promise.all(passwords.map(newPassword =>
      Promise.resolve(post("/api/auth/reset-password", { token: token(user.activation_url), newPassword }))));
    expect(activations.map(response => response.status).sort()).toEqual([200, 400]);
    const winner = activations.findIndex(response => response.status === 200);
    const userLogin = await post("/api/auth/sign-in/username", { username: createInput.username, password: passwords[winner] });
    expect(userLogin.status).toBe(200);
    const userCookie = cookieOf(userLogin);
    expect((await post("/api/auth/sign-in/username", { username: createInput.username, password: passwords[1 - winner] })).status).toBe(401);
    expect((await post("/api/trpc/admin.resetAccess", { id: bootstrap.id }, userCookie)).status).toBe(403);
    const courseResponse = await post("/api/trpc/courses.create", { name: `On-prem ${suffix}` }, adminCookie);
    expect(courseResponse.status).toBe(200);
    const courseId = (await courseResponse.json()).result.data.id;
    const invited = await post("/api/trpc/courseMemberships.invite", { courseId, emails: [createInput.email] }, adminCookie);
    expect(invited.status, await invited.clone().text()).toBe(200);
    const invitation = (await invited.json()).result.data.results[0];
    expect(invitation.invitation_url).toContain(`${origin}/course-invitations/`);
    const queued = await pool.query("SELECT count(*)::int AS count FROM external_tasks WHERE kind = 'invitation_email' AND payload->>'invitation_id' = $1", [String(invitation.invitation_id)]);
    expect(queued.rows[0].count).toBe(0);
    const renewed = await post("/api/trpc/courseMemberships.resend", { courseId, invitationId: invitation.invitation_id }, adminCookie);
    expect(renewed.status).toBe(200);
    const renewedUrl = (await renewed.json()).result.data.invitation_url;
    expect(renewedUrl).not.toBe(invitation.invitation_url);
    expect((await post("/api/trpc/courseMemberships.accept", { token: token(invitation.invitation_url) }, userCookie)).status).toBe(404);
    expect((await post("/api/trpc/courseMemberships.accept", { token: token(renewedUrl) }, userCookie)).status).toBe(200);
    for (const path of ["/api/auth/sign-up/email", "/api/auth/sign-in/social", "/api/auth/request-password-reset", "/api/auth/change-email", "/api/billing/webhook"]) {
      expect((await post(path, { provider: "google", ...createInput, password }, adminCookie)).status, path).toBe(404);
    }
    const plans = await app.request(`${origin}/api/trpc/billing.plans?input=%7B%7D`, { headers: { Cookie: adminCookie } }, env);
    expect(plans.status).toBe(404);
    expect((await post("/api/trpc/videos.createYoutube", { youtubeUrl: "https://youtube.com/watch?v=dQw4w9WgXcQ", title: "Disabled" }, adminCookie)).status).toBe(404);
    const reset = await post("/api/trpc/admin.resetAccess", { id: user.id }, adminCookie);
    expect(reset.status).toBe(200);
    const link = (await reset.json()).result.data.activation_url;
    await pool.query("UPDATE verification SET expires_at = now() - interval '1 minute' WHERE value = $1", [user.id]);
    expect((await post("/api/auth/reset-password", { token: token(link), newPassword: password })).status).toBe(400);
    expect(outbound).not.toHaveBeenCalled();
  }, 60_000);
});
