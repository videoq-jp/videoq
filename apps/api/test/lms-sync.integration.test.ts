import { issueMoodlePairing, exchangeMoodlePairing, pairingCodeChallenge } from "../src/features/lms/pairing";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, createLocalJWKSet, jwtVerify } from "jose";
import { toolJwks, toolClientAssertion } from "../src/features/lti/tool-keys";
import { ltiRoutes } from "../src/features/lti/routes";
import { spawn } from "node:child_process";
import { createMemoryRateLimitBackend } from "../src/lib/rate-limit";
import { appendCourseHistory, readCourseHistory, courseHistoryId } from "../src/features/lti/history";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { users, videos, chatLogs, videoCourses, videoCourseMembers, tags, videoTags, videoVisualRuns, videoVisualChunks, externalTasks, ltiChatLogSubjects } from "../src/db/schema";
import { provisionLmsInstallation, authenticateLmsInstallation, rotateLmsSyncToken, disconnectLmsInstallation } from "../src/repositories/lms-installation-repository";
import { getLmsResource, syncLmsResource } from "../src/repositories/lms-resource-repository";
import { resolvedLtiConfig } from "../src/features/lti/registrations";
import { resourceManifestSchema } from "../src/features/lms/resource";
import { lmsRoutes } from "../src/features/lms/routes";
import { putCredential, recordScopeVideos, readCredential } from "../src/features/lti/store";
import { getCourseWithMembers, updateChatLogFeedback } from "../src/repositories/chat-repository";
import { reserveAiAnswerUsage } from "../src/repositories/quota-repository";
import type { AppEnv, Bindings } from "../src/types/bindings";

// Keep real media writes, DB admission, confirmation and job outbox. Only delivery
// to an external queue is omitted from this PostgreSQL/HTTP integration test.
vi.mock("../src/lib/external-tasks", async original => ({
  ...await original<typeof import("../src/lib/external-tasks")>(), processExternalTaskById: vi.fn(),
}));

const databaseUrl = process.env.LMS_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const manifest = (generation = 1, overrides = {}) => resourceManifestSchema.parse({
  generation, contextId: "course-1", resourceLinkId: "lti-1", enabled: true, title: "動画教材",
  file: { filename: "lesson.mp4", contentType: "video/mp4", size: 3, contentHash: "a".repeat(40) }, ...overrides,
});
const registration = { id: "moodle-a", ownerUserId: "account-a", name: "Moodle", issuer: "https://moodle.example",
  clientId: "client-a", deploymentId: "deployment-a", authorizationUrl: "https://moodle.example/mod/lti/auth.php", jwksUrl: "https://moodle.example/mod/lti/certs.php" };

describePostgres("Moodle synchronization using existing VideoQ accounts", () => {
  const schema = "lms_sync_" + crypto.randomUUID().replaceAll("-", "");
  let admin: pg.Client;
  let pool: pg.Pool;
  let created = false;
  let env: Bindings;
  let credential: { installationId: string; token: string };
  let manualKeyRing: string;
  const grant = { id: "moodle-a", ownerUserId: "account-a" };
  const objects = new Map<string, Uint8Array>();
  const app = new Hono<AppEnv>().route("/api/lms", lmsRoutes).route("/api/lti", ltiRoutes);

  beforeAll(async () => {
    manualKeyRing = JSON.stringify({ current: await exportJWK((await generateKeyPair("RS256", { extractable: true })).privateKey), previous: [] });
    admin = new pg.Client({ connectionString: databaseUrl }); await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    const snapshot = generateDrizzleJson({ users, videos, chatLogs, videoCourses, videoCourseMembers, tags, videoTags, videoVisualRuns, videoVisualChunks, externalTasks, ltiChatLogSubjects });
    const statements = await generateMigration(generateDrizzleJson({}), snapshot);
    for (const statement of statements) await pool.query(statement.replaceAll('"public".', `"${schema}".`));
    // Apply the actual generated sync migration, including foreign keys.
    const migration = await readFile(new URL("../drizzle/0046_lti_materials.sql", import.meta.url), "utf8");
    await pool.query(migration.replaceAll('"public".', `"${schema}".`));
    const managed = await readFile(new URL("../drizzle/0047_lti_managed_keys.sql", import.meta.url), "utf8");
    await pool.query(managed.replaceAll('"public".', `"${schema}".`));
    const courseTags = await readFile(new URL('../drizzle/0056_lti_course_tags.sql', import.meta.url), 'utf8');
    await pool.query(courseTags.replaceAll('"public".', `"${schema}".`));
    await pool.query("CREATE TABLE scene_embeddings(video_id bigint)");
    env = { RUNTIME: "node", DATABASE_POOL: pool, USE_S3_STORAGE: "false",
      LTI_CONFIG: JSON.stringify({ toolOrigin: "https://api.example", databaseRegistrations: true, registrations: [] }),
      VIDEO_BUCKET: {
        put: async (key: string, body: ReadableStream) => { objects.set(key, new Uint8Array(await new Response(body).arrayBuffer())); },
        head: async (key: string) => objects.has(key) ? { size: objects.get(key)!.byteLength } : null,
      },
    } as unknown as Bindings;
  });

  beforeEach(async () => {
    objects.clear();
    env.RATE_LIMIT_BACKEND = createMemoryRateLimitBackend();
    await pool.query("TRUNCATE lti_credentials, lti_tool_keys");
    await pool.query("TRUNCATE lms_courses, lms_resources, lms_installations, video_course_members, video_courses, videos, users, external_tasks CASCADE");
    await drizzle(pool).insert(users).values(["account-a", "account-b"].map(id => ({
      id, username: id, email: id + "@example.invalid", name: id, isOverQuota: false,
      usedAiAnswers: 0, usedProcessingSeconds: 0, usedStorageBytes: 0, monthlyUploadLimitGb: null, storageLimitGb: null, aiAnswersLimit: 3,
    })));
    credential = await provisionLmsInstallation(env, registration);
  });

  afterAll(async () => {
    await pool?.end();
    try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin?.end(); }
  });

  const request = (path: string, method = "GET", body?: unknown, token?: string) => app.request("https://api.example/api/lms/" + path, {
    method, headers: { Authorization: "Bearer " + (token ?? credential.token), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, env);

  const automaticEnv = (): Bindings => ({ ...env, LTI_CONFIG: undefined, LTI_TOOL_KEYS: undefined,
    BETTER_AUTH_SECRET: "lti-test-session-secret-".repeat(3),
    BETTER_AUTH_URL: "https://api.example", USER_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 19).toString("base64url"),
    USE_S3_STORAGE: "true", R2_ACCESS_KEY_ID: "fixture", R2_SECRET_ACCESS_KEY: "fixture",
    R2_S3_ENDPOINT: "https://storage.example", R2_BUCKET_NAME: "fixture", R2_S3_REGION: "auto" });

  it("discovers an administrator-selected on-prem server without creating signing keys", async () => {
    const automatic = { ...automaticEnv(), BETTER_AUTH_URL: "https://private.example:8443", FRONTEND_URL: "https://learning.example:9443" };
    const response = await app.request("https://private.example:8443/api/lms/pairing/discovery", {}, automatic);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ toolOrigin: "https://private.example:8443", authorizationUrl: "https://learning.example:9443/moodle/connect",
      managementUrl: 'https://learning.example:9443/moodle/manage' });
    expect((await pool.query("SELECT count(*)::int AS n FROM lti_tool_keys")).rows[0].n).toBe(0);
    expect((await app.request("https://private.example:8443/api/lms/pairing/discovery", {}, { ...automatic, LTI_CONFIG: "false" })).status).toBe(404);
    expect((await app.request("https://private.example:8443/api/lms/pairing/discovery", {}, { ...automatic, FRONTEND_URL: "http://learning.example" })).status).toBe(503);
  });

  const managementInput = { issuer: registration.issuer, clientId: 'operator-client', deploymentId: '2' };
  const ownerContext = (userId?: string, body: unknown = managementInput, origin = 'https://api.example',
    overrides: Partial<Bindings> = {}, extraHeaders: Record<string, string> = {}) =>
    app.request('http://localhost/api/lms/pairing/management', { method: 'POST', headers: {
      'Content-Type': 'application/json', Origin: origin, ...(userId ? { 'X-VideoQ-Test-User-Id': userId } : {}), ...extraHeaders,
    }, body: JSON.stringify(body) }, { ...env, BETTER_AUTH_SECRET: 'owner-navigation-fixture-secret-'.repeat(3),
      BETTER_AUTH_URL: 'https://api.example', ...overrides });
  const operatorConnection = () => provisionLmsInstallation(env, { ...registration, id: 'operator',
    clientId: managementInput.clientId, deploymentId: managementInput.deploymentId });

  it('requires an independent VideoQ browser session for account navigation', async () => {
    await operatorConnection();
    for (const authorization of ['', 'Bearer ' + 'a'.repeat(64), 'Bearer vq_fixture_not_a_browser_session']) {
      expect((await ownerContext(undefined, managementInput, 'https://api.example', {},
        authorization ? { Authorization: authorization } : {})).status).toBe(401);
    }
    expect((await ownerContext('account-a', managementInput, registration.issuer)).status).toBe(403);
    expect((await ownerContext('account-a', managementInput, '')).status).toBe(403);
  });

  it('matches the exact connected owner, issuer, client and deployment without exposing owner metadata', async () => {
    await operatorConnection();
    const owned = await ownerContext('account-a');
    expect(owned.status).toBe(200);
    expect(await owned.json()).toEqual({ connection: { owned: true, active: true },
      permissions: { account: true, billing: false, systemAdmin: false } });
    for (const [user, input] of [
      ['account-b', managementInput],
      ['account-a', { ...managementInput, issuer: 'https://another.example' }],
      ['account-a', { ...managementInput, clientId: 'another-client' }],
      ['account-a', { ...managementInput, deploymentId: '3' }],
    ] as const) {
      const response = await ownerContext(user, input);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ connection: { owned: false, active: null },
        permissions: { account: false, billing: false, systemAdmin: false } });
    }
  });

  it('rejects forged account/role/redirect inputs and malformed registration identifiers', async () => {
    await operatorConnection();
    for (const body of [
      { ...managementInput, ownerUserId: 'account-a' }, { ...managementInput, role: 'admin' },
      { ...managementInput, returnTo: 'https://evil.example' }, { ...managementInput, deploymentId: '0' },
      { ...managementInput, clientId: 'x'.repeat(256) },
      ...['not-a-url', '//evil.example', 'http://moodle.example', 'https://user:secret@moodle.example', 'https://moodle.example/?secret=1',
        'https://moodle.example/#fragment', ' https://moodle.example'].map(issuer => ({ ...managementInput, issuer })),
    ]) expect((await ownerContext('account-a', body)).status).toBe(400);
  });

  it('uses the current VideoQ system role without treating a Moodle connection as an admin grant', async () => {
    await operatorConnection();
    await pool.query("UPDATE users SET role='admin' WHERE id='account-b'");
    expect(await (await ownerContext('account-b')).json()).toEqual({ connection: { owned: false, active: null },
      permissions: { account: false, billing: false, systemAdmin: true } });
    await pool.query("UPDATE users SET role='user' WHERE id='account-b'");
    expect(await (await ownerContext('account-b')).json()).toEqual({ connection: { owned: false, active: null },
      permissions: { account: false, billing: false, systemAdmin: false } });
  });

  it('keeps billing recovery available to a cloud owner and does not reactivate disconnected Moodle access', async () => {
    await operatorConnection();
    await pool.query("UPDATE lms_installations SET active=false WHERE id='operator'; UPDATE users SET is_over_quota=true WHERE id='account-a'");
    const cloud = await ownerContext('account-a', managementInput, 'https://api.example', { DEPLOYMENT_EDITION: 'cloud' });
    expect(cloud.status).toBe(200);
    expect(await cloud.json()).toEqual({ connection: { owned: true, active: false },
      permissions: { account: true, billing: true, systemAdmin: false } });
    expect((await pool.query("SELECT active FROM lms_installations WHERE id='operator'")).rows).toEqual([{ active: false }]);
    expect(await (await ownerContext('account-a', managementInput, 'https://api.example', { DEPLOYMENT_EDITION: 'onprem' })).json())
      .toEqual({ connection: { owned: true, active: false }, permissions: { account: true, billing: false, systemAdmin: false } });
  });

  it.each([registration.issuer, "https://Moodle.Example:443/academy"])("requires S256 proof and preserves the Moodle issuer during exchange and recovery: %s", async issuer => {
    const automatic = automaticEnv();
    const verifier = "browser-session-private-verifier-" + "a".repeat(32);
    const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
    expect(await pairingCodeChallenge(verifier)).toBe(codeChallenge);
    const approved = await app.request("http://localhost/api/lms/pairing", { method: "POST",
      headers: { "X-VideoQ-Test-User-Id": "account-a", Origin: "https://api.example", "Content-Type": "application/json" },
      body: JSON.stringify({ moodleUrl: issuer, codeChallenge }) }, automatic);
    expect(approved.status).toBe(200);
    const { code } = await approved.json<{ code: string }>();
    const input = { secret: JSON.parse(atob(code.slice(8))).secret, issuer, clientId: "browser-client", deploymentId: "7",
      mode: "materials" as const, materialsService: { tokenEndpoint: issuer + "/local/videoq/token.php", endpoint: issuer + "/local/videoq/materials.php" } };
    await expect(exchangeMoodlePairing(automatic, input)).rejects.toThrow("INVALID_PAIRING_CODE");
    await expect(exchangeMoodlePairing(automatic, { ...input, codeVerifier: "x".repeat(43) })).rejects.toThrow("INVALID_PAIRING_CODE");
    expect((await pool.query("SELECT count(*)::int AS n FROM lms_installations WHERE client_id='browser-client'")).rows[0].n).toBe(0);
    const connected = await exchangeMoodlePairing(automatic, { ...input, codeVerifier: verifier });
    expect(await exchangeMoodlePairing(automatic, { ...input, codeVerifier: verifier })).toEqual(connected);
    await expect(exchangeMoodlePairing(automatic, input)).rejects.toThrow("INVALID_PAIRING_CODE");
    await expect(exchangeMoodlePairing(automatic, { ...input, codeVerifier: "x".repeat(43) })).rejects.toThrow("INVALID_PAIRING_CODE");
  });

  it("needs no LTI-specific settings and initializes encrypted keys only on authenticated code issuance", async () => {
    const automatic = automaticEnv();
    expect(await toolJwks(automatic)).toEqual({ keys: [] });
    const listing = await app.request("http://localhost/api/lms/pairing", {
      headers: { "X-VideoQ-Test-User-Id": "account-a" },
    }, automatic);
    expect(listing.status).toBe(200);
    expect((await pool.query("SELECT count(*)::int AS n FROM lti_tool_keys")).rows[0].n).toBe(0);
    const anonymous = await app.request("https://api.example/api/lms/pairing", { method: "POST",
      headers: { Origin: "https://api.example", "Content-Type": "application/json" }, body: JSON.stringify({ moodleUrl: registration.issuer }) }, automatic);
    expect(anonymous.status).toBe(401);
    expect((await pool.query("SELECT count(*)::int AS n FROM lti_tool_keys")).rows[0].n).toBe(0);
    const issued = await app.request("http://localhost/api/lms/pairing", { method: "POST",
      headers: { "X-VideoQ-Test-User-Id": "account-a", Origin: "https://api.example", "Content-Type": "application/json" },
      body: JSON.stringify({ moodleUrl: registration.issuer }) }, automatic);
    expect(issued.status).toBe(200);
    const pairing = await issued.json<{ code: string }>();
    expect(pairing.code).toMatch(/^VIDEOQ2\./);
    expect(JSON.parse(atob(pairing.code.slice(8))).origin).toBe("https://api.example");
    const published = await app.request("https://api.example/api/lti/jwks", {}, automatic);
    expect(published.status).toBe(200);
    const jwks = await published.json<Awaited<ReturnType<typeof toolJwks>>>();
    expect(jwks.keys).toHaveLength(1);
    expect(Object.keys(jwks.keys[0]).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
    const stored = (await pool.query("SELECT encrypted_key_ring FROM lti_tool_keys")).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0].encrypted_key_ring).toMatch(/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(stored[0].encrypted_key_ring).not.toContain(jwks.keys[0].n);
    const assertion = await toolClientAssertion(automatic, "client", "7", registration.issuer + "/token");
    const verified = await jwtVerify(assertion, createLocalJWKSet(jwks), { issuer: "client", audience: registration.issuer + "/token", algorithms: ["RS256"] });
    expect(verified.payload.sub).toBe("client");
    const connected = await exchangeMoodlePairing(automatic, { secret: JSON.parse(atob(pairing.code.slice(8))).secret,
      issuer: registration.issuer, clientId: "automatic-client", deploymentId: "7", mode: "materials",
      materialsService: { tokenEndpoint: registration.issuer + "/local/videoq/token.php", endpoint: registration.issuer + "/local/videoq/materials.php" } });
    expect(connected.toolOrigin).toBe("https://api.example");
    expect((await pool.query("SELECT sync_token_hash FROM lms_installations WHERE id=$1", [connected.installationId])).rows[0].sync_token_hash).toBeNull();
    expect((await resolvedLtiConfig(automatic))?.registrations.some(item => item.clientId === "automatic-client" && item.materialsService)).toBe(true);
  });

  it("allows the administrator to disable automatic setup explicitly", async () => {
    const disabled = { ...automaticEnv(), LTI_CONFIG: "false" };
    expect((await app.request("http://localhost/api/lms/pairing", { headers: { "X-VideoQ-Test-User-Id": "account-a" } }, disabled)).status).toBe(404);
    expect((await app.request("https://api.example/api/lti/jwks", {}, disabled)).status).toBe(404);
    expect((await pool.query("SELECT count(*)::int AS n FROM lti_tool_keys")).rows[0].n).toBe(0);
  });

  it("shares one signing identity across concurrent replicas with one-connection pools", async () => {
    const replicas = Array.from({ length: 2 }, () => new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 1, connectionTimeoutMillis: 3000 }));
    try {
      const automatic = { ...automaticEnv(), DATABASE_POOL: replicas[0] };
      const codes = await Promise.all(Array.from({ length: 6 }, (_, index) => issueMoodlePairing({ ...automatic, DATABASE_POOL: replicas[index % 2] },
        index % 2 ? "account-a" : "account-b", registration.issuer, "https://api.example")));
      expect(codes.every(code => code.code.startsWith("VIDEOQ2."))).toBe(true);
      expect((await pool.query("SELECT count(*)::int AS n FROM lti_tool_keys")).rows[0].n).toBe(1);
      const first = await toolJwks(automatic);
      await issueMoodlePairing(automatic, "account-a", registration.issuer, "https://api.example");
      expect(await toolJwks(automatic)).toEqual(first);
      for (const replica of replicas) expect(replica.totalCount).toBe(1);
    } finally { await Promise.all(replicas.map(replica => replica.end())); }
  });

  it("reuses persisted keys in a fresh process", async () => {
    const automatic = automaticEnv(); await issueMoodlePairing(automatic, "account-a", registration.issuer, "https://api.example");
    const expected = await toolJwks(automatic);
    const url = new URL(databaseUrl!); url.searchParams.set("options", `-c search_path=${schema}`);
    const published = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
        "import {toolJwks} from './src/features/lti/tool-keys.ts';let data='';for await(const part of process.stdin)data+=part;console.log(JSON.stringify(await toolJwks(JSON.parse(data))));"],
        { cwd: new URL("../", import.meta.url), stdio: ["pipe", "pipe", "pipe"] });
      let output = ""; child.stdout.on("data", chunk => { output += String(chunk); }); child.stderr.resume();
      child.on("error", () => reject(new Error("Fresh signing-key process failed")));
      child.on("close", status => status === 0 ? resolve(output) : reject(new Error("Fresh signing-key process failed")));
      child.stdin.end(JSON.stringify({ DATABASE_URL: url.toString(), USER_SECRET_ENCRYPTION_KEY: automatic.USER_SECRET_ENCRYPTION_KEY }));
    });
    expect(JSON.parse(published)).toEqual(expected);
  });

  it("preserves its identity when encrypted database state is restored", async () => {
    const automatic = automaticEnv(); await issueMoodlePairing(automatic, "account-a", registration.issuer, "https://api.example");
    const expected = await toolJwks(automatic);
    const backup = (await pool.query("SELECT id,encrypted_key_ring,created_at FROM lti_tool_keys")).rows[0];
    await pool.query("DELETE FROM lti_tool_keys");
    await pool.query("INSERT INTO lti_tool_keys(id,encrypted_key_ring,created_at) VALUES($1,$2,$3)", [backup.id, backup.encrypted_key_ring, backup.created_at]);
    expect(await toolJwks(automatic)).toEqual(expected);
  });

  it("does not replace an existing identity when decryption fails", async () => {
    const automatic = automaticEnv(); await issueMoodlePairing(automatic, "account-a", registration.issuer, "https://api.example");
    const before = (await pool.query("SELECT * FROM lti_tool_keys")).rows;
    const wrong = { ...automatic, USER_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 20).toString("base64url") };
    await expect(toolJwks(wrong)).rejects.toThrow("could not be loaded");
    await expect(issueMoodlePairing(wrong, "account-a", registration.issuer, "https://api.example")).rejects.toThrow("initialization failed");
    expect((await pool.query("SELECT * FROM lti_tool_keys")).rows).toEqual(before);
    expect((await toolJwks(automatic)).keys).toHaveLength(1);
  });

  it("does not initialize keys for an inactive owner", async () => {
    const automatic = automaticEnv(); await pool.query("UPDATE users SET is_active=false WHERE id='account-a'");
    await expect(issueMoodlePairing(automatic, "account-a", registration.issuer, "https://api.example")).rejects.toThrow();
    expect((await pool.query("SELECT count(*)::int AS n FROM lti_tool_keys")).rows[0].n).toBe(0);
  });

  it("retains the application identity when one owning account is deleted", async () => {
    const automatic = automaticEnv(); await issueMoodlePairing(automatic, "account-a", registration.issuer, "https://api.example");
    const expected = await toolJwks(automatic);
    await pool.query("DELETE FROM users WHERE id='account-a'");
    await issueMoodlePairing(automatic, "account-b", registration.issuer, "https://api.example");
    expect(await toolJwks(automatic)).toEqual(expected);
  });

  it("disconnects only the owner's installation, revokes sync/LTI and retains all learning data", async () => {
    const resource = await syncLmsResource(env, grant, "disconnect-source", manifest());
    const peer = await provisionLmsInstallation(env, { ...registration, id: "peer", ownerUserId: "account-b", clientId: "peer" });
    const pending = await issueMoodlePairing(env, "account-a", registration.issuer, "https://api.example");
    const { secret } = JSON.parse(atob(pending.code.slice(8))) as { secret: string };
    const before = (await pool.query("SELECT (SELECT count(*) FROM videos) AS videos,(SELECT count(*) FROM video_courses) AS courses,(SELECT count(*) FROM lms_resources) AS resources,(SELECT count(*) FROM external_tasks) AS tasks")).rows;
    const url = "http://localhost/api/lms/pairing/connections/moodle-a/disconnect";
    const headers = { "X-VideoQ-Test-User-Id": "account-b", Origin: "https://api.example" };
    expect((await app.request(url, { method: "POST", headers }, env)).status).toBe(404);
    expect(await authenticateLmsInstallation(env, credential.token)).not.toBeNull();
    expect((await app.request(url, { method: "POST", headers: { ...headers, "X-VideoQ-Test-User-Id": "account-a", Origin: "https://evil.example" } }, env)).status).toBe(403);
    const ownHeaders = { ...headers, "X-VideoQ-Test-User-Id": "account-a" };
    expect((await app.request(url, { method: "POST", headers: ownHeaders }, env)).status).toBe(200);
    expect((await app.request(url, { method: "POST", headers: ownHeaders }, env)).status).toBe(200);
    expect(await authenticateLmsInstallation(env, credential.token)).toBeNull();
    expect(await authenticateLmsInstallation(env, peer.token)).toMatchObject({ id: "peer" });
    expect((await request("connection")).status).toBe(401);
    expect((await resolvedLtiConfig(env))?.registrations.some(item => item.id === "db:moodle-a")).toBe(false);
    expect(await getLmsResource(env, grant, "disconnect-source")).toBeNull();
    const [retained] = (await pool.query("SELECT video_id,enabled FROM lms_resources WHERE installation_id=$1 AND external_id=$2", [grant.id, "disconnect-source"])).rows;
    expect(Number(retained.video_id)).toBe(resource.videoId);
    expect(retained.enabled).toBe(true);
    expect((await pool.query("SELECT (SELECT count(*) FROM videos) AS videos,(SELECT count(*) FROM video_courses) AS courses,(SELECT count(*) FROM lms_resources) AS resources,(SELECT count(*) FROM external_tasks) AS tasks")).rows).toEqual(before);
    await expect(exchangeMoodlePairing(env, { secret, issuer: registration.issuer, clientId: "new", deploymentId: "3", syncToken: "c".repeat(64) })).rejects.toMatchObject({ code: "INVALID_PAIRING_CODE" });
    await expect(syncLmsResource(env, grant, "disconnect-source", manifest(2, { enabled: false }))).rejects.toMatchObject({ code: "INSTALLATION_UNAVAILABLE" });
  });

  const pairingInput = (secret: string, overrides = {}) => ({ secret, issuer: "https://moodle.example/campus",
    clientId: "new-client", deploymentId: "17", syncToken: "b".repeat(64), ...overrides });
  async function pairingCode(owner = "account-a") {
    const issued = await issueMoodlePairing(env, owner, "https://moodle.example/campus", "https://api.example");
    return { ...issued, ...JSON.parse(atob(issued.code.slice(8))) as { secret: string; origin: string } };
  }
  it("pairs an account-bound Moodle once and supplies the working synchronization identity", async () => {
    const code = await pairingCode();
    expect(code.origin).toBe("https://api.example");
    const saved = await exchangeMoodlePairing(env, pairingInput(code.secret));
    expect(await authenticateLmsInstallation(env, "b".repeat(64))).toMatchObject({ id: saved.installationId,
      ownerUserId: "account-a", issuer: "https://moodle.example/campus", clientId: "new-client", deploymentId: "17" });
    const { rows } = await pool.query("SELECT * FROM lms_installations WHERE id=$1", [saved.installationId]);
    expect(rows[0].authorization_url).toBe("https://moodle.example/campus/mod/lti/auth.php");
    expect(rows[0].jwks_url).toBe("https://moodle.example/campus/mod/lti/certs.php");
    expect(JSON.stringify(rows)).not.toContain("b".repeat(64));
    await expect(exchangeMoodlePairing(env, pairingInput(code.secret))).rejects.toMatchObject({ code: "INVALID_PAIRING_CODE" });
  });
  it("rejects a different Moodle URL without consuming the valid code", async () => {
    const code = await pairingCode();
    await expect(exchangeMoodlePairing(env, pairingInput(code.secret, { issuer: "https://other.example" })))
      .rejects.toMatchObject({ code: "INVALID_PAIRING_CODE" });
    await expect(exchangeMoodlePairing(env, pairingInput(code.secret))).resolves.toHaveProperty("installationId");
  });
  it("revokes old unused codes when a new code is issued", async () => {
    const first = await pairingCode();
    const second = await pairingCode();
    await expect(exchangeMoodlePairing(env, pairingInput(first.secret))).rejects.toMatchObject({ code: "INVALID_PAIRING_CODE" });
    await expect(exchangeMoodlePairing(env, pairingInput(second.secret))).resolves.toHaveProperty("installationId");
  });
  it("allows exactly one concurrent redemption", async () => {
    const code = await pairingCode();
    const results = await Promise.allSettled([exchangeMoodlePairing(env, pairingInput(code.secret)), exchangeMoodlePairing(env, pairingInput(code.secret))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  });
  it("rejects expired codes and owners deactivated after issuance", async () => {
    const expired = await pairingCode();
    await pool.query("UPDATE lti_credentials SET expires_at=now()-interval '1 second'");
    await expect(exchangeMoodlePairing(env, pairingInput(expired.secret))).rejects.toMatchObject({ code: "INVALID_PAIRING_CODE" });
    const code = await pairingCode();
    await pool.query("UPDATE users SET is_active=false WHERE id='account-a'");
    await expect(exchangeMoodlePairing(env, pairingInput(code.secret))).rejects.toMatchObject({ code: "INACTIVE_ACCOUNT" });
    await expect(pairingCode()).rejects.toMatchObject({ code: "INACTIVE_ACCOUNT" });
  });
  it("does not overwrite another account's existing LTI identity", async () => {
    const code = await pairingCode("account-b");
    await expect(exchangeMoodlePairing(env, pairingInput(code.secret, { issuer: registration.issuer,
      clientId: registration.clientId, deploymentId: "1" }))).rejects.toMatchObject({ code: "INVALID_PAIRING_CODE" });
    const bound = await issueMoodlePairing(env, "account-b", registration.issuer, "https://api.example");
    const { secret } = JSON.parse(atob(bound.code.slice(8))) as { secret: string };
    await expect(exchangeMoodlePairing(env, pairingInput(secret, { issuer: registration.issuer,
      clientId: registration.clientId, deploymentId: "1" }))).rejects.toMatchObject({ code: "CONNECTION_EXISTS" });
    expect(await authenticateLmsInstallation(env, credential.token)).toMatchObject({ ownerUserId: "account-a" });
  });
  it("requires a browser session and allowed Origin to issue a code, and ignores caller-selected owners", async () => {
    const url = "http://localhost/api/lms/pairing";
    const body = JSON.stringify({ moodleUrl: "https://moodle.example" });
    const options = { method: "POST", headers: { "X-VideoQ-Test-User-Id": "account-a", "Content-Type": "application/json", Origin: "https://api.example" }, body };
    expect((await app.request(url, { ...options, headers: { ...options.headers, Origin: "https://evil.example" } }, env)).status).toBe(403);
    expect((await app.request(url, { ...options, body: JSON.stringify({ moodleUrl: "https://moodle.example", ownerUserId: "account-b" }) }, env)).status).toBe(400);
    const issued = await app.request(url, options, env);
    expect(issued.status).toBe(200);
    const { code } = await issued.json<{ code: string }>();
    const { secret } = JSON.parse(atob(code.slice(8))) as { secret: string };
    const response = await app.request("http://localhost/api/lms/pairing/exchange", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(pairingInput(secret, { issuer: "https://moodle.example" })) }, env);
    expect(response.status).toBe(200);
    const list = await app.request(url, { headers: { "X-VideoQ-Test-User-Id": "account-b" } }, env);
    expect(await list.json()).toEqual({ connections: [] });
    const own = await app.request(url, { headers: { "X-VideoQ-Test-User-Id": "account-a" } }, env);
    expect((await own.json<{ connections: unknown[] }>()).connections).toHaveLength(2);
  });

  it("shares completed history across video launches, isolates learners/courses, and revokes restricted context", async () => {
    const resource = await syncLmsResource(env, grant, "history-video", manifest(1));
    const courseId = resource.courseId!;
    const videoId = resource.videoId!;
    const scope = { registrationId: "db:moodle-a", subjectHash: "learner-a", courseId };
    const answer = { segments: [{ text: "Saved answer", sourceIds: [1] }], sources: [{ id: 1, video_id: videoId, title: "Lesson", start_time: "00:00:00", end_time: "00:00:10" }] };
    const insertLog = async (question: string) => (await drizzle(pool).insert(chatLogs).values({ userId: "account-a", courseId,
      question, response: answer, isSharedOrigin: false, createdAt: new Date().toISOString(), retrievedContexts: [] }).returning())[0].id;
    const ids = await Promise.all(Array.from({ length: 4 }, (_, i) => insertLog("question-" + i)));
    await Promise.all(ids.map((id, i) => appendCourseHistory(env, scope, "question-" + i, id, [videoId])));
    const history = await readCourseHistory(env, scope, "account-a", [videoId]);
    expect(history).toHaveLength(4);
    expect(new Set(history.map(turn => turn.logId))).toEqual(new Set(ids));
    expect(await readCourseHistory(env, { ...scope, subjectHash: "learner-b" }, "account-a", [videoId])).toEqual([]);
    expect(await readCourseHistory(env, { ...scope, courseId: courseId + 1 }, "account-a", [videoId])).toEqual([]);
    expect(await readCourseHistory(env, { ...scope, registrationId: "another-school" }, "account-a", [videoId])).toEqual([]);
    expect(await readCourseHistory(env, scope, "account-b", [videoId])).toEqual([]);
    expect(await readCourseHistory(env, scope, "account-a", [])).toEqual([]);
    expect(await readCourseHistory(env, scope, "account-a", [videoId, 999])).toHaveLength(4);
    await pool.query("UPDATE chat_logs SET feedback='good' WHERE id=$1", [ids[0]]);
    expect((await readCourseHistory(env, scope, "account-a", [videoId])).find(turn => turn.logId === ids[0])?.feedback).toBe("good");
    await appendCourseHistory(env, scope, "scope reduced", await insertLog("scope reduced"), []);
    expect(await readCourseHistory(env, scope, "account-a", [])).toEqual([]); // the saved answer itself references a now-forbidden video
    await pool.query("UPDATE lti_credentials SET expires_at=now()-interval '1 second' WHERE id=$1", [await courseHistoryId(scope)]);
    await appendCourseHistory(env, scope, "fresh turn", await insertLog("fresh turn"), [videoId]);
    expect((await readCourseHistory(env, scope, "account-a", [videoId])).map(turn => turn.question)).toEqual(["fresh turn"]);
    const recentIds = await Promise.all(Array.from({ length: 55 }, (_, i) => insertLog("recent-" + i)));
    await Promise.all(recentIds.map((id, i) => appendCourseHistory(env, scope, "recent-" + i, id, [videoId])));
    const recent = await readCourseHistory(env, scope, "account-a", [videoId]);
    expect(recent).toHaveLength(50);
    expect(new Set(recent.map(turn => turn.logId)).size).toBe(50);
    expect(recent.every(turn => turn.question.startsWith("recent-"))).toBe(true);

  });

  it("migrates an approved identity without moving videos and recovers a lost pairing response", async () => {
    const original = await syncLmsResource(env, grant, "10", manifest());
    const serviceEnv = { ...env, USE_S3_STORAGE: "true", LTI_TOOL_KEYS: manualKeyRing,
      R2_ACCESS_KEY_ID: "fixture", R2_SECRET_ACCESS_KEY: "fixture", R2_S3_ENDPOINT: "https://storage.example",
      R2_BUCKET_NAME: "fixture", R2_S3_REGION: "auto" } as Bindings;
    const pairing = await issueMoodlePairing(serviceEnv, "account-a", registration.issuer, "https://api.example");
    expect(pairing.code.startsWith("VIDEOQ2.")).toBe(true);
    const { secret } = JSON.parse(atob(pairing.code.slice(8)));
    const request = { secret, issuer: registration.issuer, clientId: registration.clientId, deploymentId: "7", mode: "materials" as const,
      materialsService: { tokenEndpoint: registration.issuer + "/local/videoq/token.php", endpoint: registration.issuer + "/local/videoq/materials.php" } };
    const connected = await exchangeMoodlePairing(serviceEnv, request);
    expect(connected).toMatchObject({ installationId: grant.id, toolOrigin: "https://api.example",
      uploadTargets: [{ origin: "https://storage.example", prefix: "/fixture/media/videos/account-a/" }] });
    expect(await exchangeMoodlePairing(serviceEnv, request)).toEqual(connected);
    const current = await getLmsResource(serviceEnv, grant, "10");
    expect(current?.video?.id).toBe(original.videoId);
    expect(current?.resource.courseId).toBe(original.courseId);
    expect(await authenticateLmsInstallation(serviceEnv, credential.token)).toBeNull();
    expect(await rotateLmsSyncToken(serviceEnv, "account-a", grant.id)).toBeNull();
    const connection = (await pool.query("SELECT sync_token_hash,materials_service FROM lms_installations WHERE id=$1", [grant.id])).rows[0];
    expect(connection.sync_token_hash).toBeNull();
    expect(connection.materials_service.endpoint).toBe(registration.issuer + "/local/videoq/materials.php");
    await syncLmsResource(serviceEnv, grant, "10", manifest(2, { enabled: false, deleted: true }));
    const late = (await pool.query("SELECT payload,available_at > now()+interval '1 hour' AS delayed FROM external_tasks WHERE dedupe_key LIKE '%:late-upload'")).rows;
    expect(late).toHaveLength(1);
    expect(late[0].delayed).toBe(true);
    expect(late[0].payload.bytes).toBeNull(); // the second deletion must never refund storage twice
    expect(await disconnectLmsInstallation(serviceEnv, "account-a", grant.id)).toBe(true);
    await expect(exchangeMoodlePairing(serviceEnv, request)).rejects.toMatchObject({ code: "INVALID_PAIRING_CODE" });
  });

  it("creates no user accounts and binds media/quota to the school's existing account", async () => {
    const resource = await syncLmsResource(env, grant, "10", manifest());
    expect(resource.videoId).not.toBeNull();
    expect((await pool.query("SELECT managed_by_lms FROM video_courses WHERE id=$1", [resource.courseId])).rows[0].managed_by_lms).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS count FROM users")).rows[0].count).toBe(2);
    expect((await pool.query("SELECT user_id FROM videos")).rows[0].user_id).toBe("account-a");
    expect((await pool.query("SELECT used_storage_bytes::int, used_upload_bytes::int FROM users WHERE id='account-a'")).rows[0])
      .toEqual({ used_storage_bytes: 3, used_upload_bytes: 3 });
    expect(await getLmsResource(env, { ...grant, ownerUserId: "account-b" }, "10")).toBeNull();
  });

  it("does not duplicate media or upload usage under twenty concurrent retries", async () => {
    const resources = await Promise.all(Array.from({ length: 20 }, () => syncLmsResource(env, grant, "10", manifest())));
    expect(new Set(resources.map(value => value.videoId)).size).toBe(1);
    expect((await pool.query("SELECT used_upload_bytes::int FROM users WHERE id='account-a'")).rows[0].used_upload_bytes).toBe(3);
  });

  it("shares and enforces the existing account's monthly answer quota", async () => {
    const result = await Promise.all(Array.from({ length: 20 }, () => reserveAiAnswerUsage(env, "account-a")));
    expect(result.filter(value => "reservation" in value)).toHaveLength(3);
    expect(result.filter(value => "exceeded" in value)).toHaveLength(17);
  });

  it("transfers a video through HTTP and confirms exactly one real transcription outbox task", async () => {
    const response = await request("resources/10", "PUT", manifest());
    expect(response.status).toBe(200);
    const result = await response.json<{ upload: { url: string }; generation: number }>();
    // Processing bindings remain available to freshly authorized content managers;
    // learner access is independently limited to completed material.
    expect((await resolvedLtiConfig(env))!.registrations[0].resources.map(item => ({ generation: item.generation, learningAvailable: item.learningAvailable })))
      .toEqual([{ generation: 1, learningAvailable: false }]);
    const uploaded = await app.request(result.upload.url, { method: "PUT", headers: {
      Authorization: "Bearer " + credential.token, "Content-Type": "video/mp4", "Content-Length": "3",
    }, body: new Uint8Array([1, 2, 3]) }, env);
    expect(uploaded.status).toBe(200);
    expect((await request("resources/10/confirm", "POST", { generation: 1 })).status).toBe(200);
    expect((await request("resources/10/confirm", "POST", { generation: 1 })).status).toBe(200);
    expect((await pool.query("SELECT count(*)::int AS count FROM external_tasks WHERE kind='sqs_job'")).rows[0].count).toBe(1);
    await pool.query("UPDATE videos SET status='completed'");
    expect((await resolvedLtiConfig(env))!.registrations[0].resources).toMatchObject([{ contextId: "course-1", resourceLinkId: "lti-1", generation: 1, learningAvailable: true }]);
    // A confirmed object cannot be overwritten by a late API PUT.
    const late = await app.request(result.upload.url, { method: "PUT", headers: {
      Authorization: "Bearer " + credential.token, "Content-Type": "video/mp4", "Content-Length": "3",
    }, body: new Uint8Array([4, 5, 6]) }, env);
    expect(late.status).toBe(409);
  });

  it("replaces media, revokes its old binding and refuses delayed manifests", async () => {
    const initial = await syncLmsResource(env, grant, "10", manifest());
    await pool.query("UPDATE videos SET status='completed'");
    const next = manifest(2, { file: { ...manifest().file, contentHash: "b".repeat(40) } });
    const replacement = await syncLmsResource(env, grant, "10", next);
    expect(replacement.videoId).not.toBe(initial.videoId);
    expect((await resolvedLtiConfig(env))!.registrations[0].resources.map(item => ({ videoId: item.videoId,
      generation: item.generation, learningAvailable: item.learningAvailable })))
      .toEqual([{ videoId: replacement.videoId, generation: 2, learningAvailable: false }]);
    expect((await pool.query("SELECT count(*)::int AS count FROM videos")).rows[0].count).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM external_tasks WHERE kind='storage_cleanup'")).rows[0].count).toBe(1);
    await expect(syncLmsResource(env, grant, "10", manifest())).rejects.toMatchObject({ status: 409 });
    await expect(syncLmsResource(env, grant, "10", manifest(2, { title: "stale different body" }))).rejects.toMatchObject({ status: 409 });
  });

  it("renames a lesson without retransferring bytes", async () => {
    const initial = await syncLmsResource(env, grant, "10", manifest());
    const renamed = await syncLmsResource(env, grant, "10", manifest(2, { title: "新しい教材名" }));
    expect(renamed.videoId).toBe(initial.videoId);
    expect((await pool.query("SELECT title FROM videos")).rows[0].title).toBe("新しい教材名");
    expect((await pool.query("SELECT used_upload_bytes::int FROM users WHERE id='account-a'")).rows[0].used_upload_bytes).toBe(3);
  });

  it('marks source authority on creation and repairs legacy flags on an unchanged generation', async () => {
    const initial = await syncLmsResource(env, grant, '10', manifest());
    expect((await pool.query('SELECT managed_by_lms FROM videos WHERE id=$1', [initial.videoId])).rows[0].managed_by_lms).toBe(true);
    expect((await pool.query('SELECT managed_by_lms,native_access_disabled FROM video_courses WHERE id=$1', [initial.courseId])).rows[0])
      .toEqual({ managed_by_lms: true, native_access_disabled: true });
    await pool.query('UPDATE videos SET managed_by_lms=false WHERE id=$1', [initial.videoId]);
    await pool.query('UPDATE video_courses SET managed_by_lms=false,native_access_disabled=false WHERE id=$1', [initial.courseId]);
    const repaired = await syncLmsResource(env, grant, '10', manifest());
    expect(repaired.videoId).toBe(initial.videoId);
    expect((await pool.query('SELECT managed_by_lms FROM videos WHERE id=$1', [initial.videoId])).rows[0].managed_by_lms).toBe(true);
    expect((await pool.query('SELECT managed_by_lms,native_access_disabled FROM video_courses WHERE id=$1', [initial.courseId])).rows[0])
      .toEqual({ managed_by_lms: true, native_access_disabled: true });
  });

  it("revokes an obsolete lesson even when the replacement exceeds storage quota", async () => {
    await syncLmsResource(env, grant, "10", manifest());
    await pool.query("UPDATE videos SET status='completed'");
    await pool.query("UPDATE users SET storage_limit_gb = 3.0 / 1073741824 WHERE id='account-a'");
    const result = await syncLmsResource(env, grant, "10", manifest(2, { file: { ...manifest().file, contentHash: "b".repeat(40) } }));
    expect(result.syncError).toBe("STORAGE_LIMIT_EXCEEDED"); expect(result.videoId).toBeNull();
    expect((await resolvedLtiConfig(env))!.registrations[0].resources).toHaveLength(0);
    expect((await request("resources/10")).status).toBe(200);
  });

  it("deletes remote media, preserves the shared course and retains a replay tombstone", async () => {
    await syncLmsResource(env, grant, "10", manifest());
    const deleted = await syncLmsResource(env, grant, "10", manifest(2, { enabled: false, deleted: true, file: undefined }));
    expect(deleted).toMatchObject({ enabled: false, videoId: null });
    expect(deleted.courseId).not.toBeNull();
    expect((await pool.query("SELECT count(*)::int AS count FROM video_courses")).rows[0].count).toBe(1);
    expect((await pool.query("SELECT used_upload_bytes::int FROM users WHERE id='account-a'")).rows[0].used_upload_bytes).toBe(0);
    await expect(syncLmsResource(env, grant, "10", manifest())).rejects.toMatchObject({ status: 409 });
  });

  it("groups videos by Moodle course without deleting siblings on replace, disable, move or delete", async () => {
    const first = await syncLmsResource(env, grant, "10", manifest(1, { courseTitle: "講座A" }));
    const second = await syncLmsResource(env, grant, "11", manifest(1, { resourceLinkId: "lti-2", courseTitle: "講座A" }));
    expect(second.courseId).toBe(first.courseId);
    const members = async (id: number) => (await pool.query("SELECT video_id::int AS id FROM video_course_members WHERE course_id=$1 ORDER BY video_id", [id])).rows.map(row => row.id);
    expect(await members(first.courseId!)).toEqual([first.videoId, second.videoId]);
    const scoped = await getCourseWithMembers(env, { courseId: first.courseId!, ltiCourseGrant: first.courseId!, ltiVideoGrant: [second.videoId!] });
    expect(scoped?.memberVideoIds).toEqual([second.videoId]);
    const replaced = await syncLmsResource(env, grant, "10", manifest(2, { file: { ...manifest().file, contentHash: "b".repeat(40) } }));
    expect(await members(first.courseId!)).toEqual([second.videoId, replaced.videoId]);
    await syncLmsResource(env, grant, "10", manifest(3, { enabled: false }));
    expect(await members(first.courseId!)).toEqual([second.videoId]);
    const moved = await syncLmsResource(env, grant, "11", manifest(2, { contextId: "course-2", resourceLinkId: "lti-2" }));
    expect(moved.courseId).not.toBe(first.courseId);
    expect(await members(first.courseId!)).toEqual([]);
    expect(await members(moved.courseId!)).toEqual([second.videoId]);
    await syncLmsResource(env, grant, "11", manifest(3, { contextId: "course-2", resourceLinkId: "lti-2", enabled: false, deleted: true }));
    expect(await members(moved.courseId!)).toEqual([]);
  });

  it("atomically remembers every previously allowed video without extending session expiry", async () => {
    const id = "c".repeat(64);
    await putCredential(env, id, "session", { scopeVideoIds: [1], subjectHash: "test" }, 60);
    const before = (await pool.query("SELECT expires_at FROM lti_credentials WHERE id=$1", [id])).rows[0].expires_at;
    await Promise.all([recordScopeVideos(env, id, [1, 2]), recordScopeVideos(env, id, [1, 3])]);
    const saved = await readCredential(env, id, "session") as { scopeVideoIds: number[] };
    expect(saved.scopeVideoIds.sort()).toEqual([1, 2, 3]);
    const after = (await pool.query("SELECT expires_at FROM lti_credentials WHERE id=$1", [id])).rows[0].expires_at;
    expect(after).toEqual(before);
    await pool.query("UPDATE lti_credentials SET expires_at=now()-interval '1 second' WHERE id=$1", [id]);
    expect(await recordScopeVideos(env, id, [4])).toBeNull();
  });

  it("persists LTI ratings only on shared-origin logs of the granted course", async () => {
    const resource = await syncLmsResource(env, grant, "10", manifest());
    const rows = await drizzle(pool).insert(chatLogs).values([true, false].map(isSharedOrigin => ({
      courseId: resource.courseId!, userId: "account-a", question: "質問", response: { segments: [{ text: "回答", sourceIds: [] }], sources: [] },
      isSharedOrigin, createdAt: new Date().toISOString(), retrievedContexts: [],
    }))).returning();
    for (const feedback of ["good", "bad", null] as const) {
      expect(await updateChatLogFeedback(env, rows[0].id, feedback, { ltiCourseGrant: resource.courseId! })).toMatchObject({ id: rows[0].id, feedback });
      expect((await pool.query("SELECT feedback FROM chat_logs WHERE id=$1", [rows[0].id])).rows[0].feedback).toBe(feedback);
    }
    expect(await updateChatLogFeedback(env, rows[0].id, "bad", { ltiCourseGrant: resource.courseId! + 999 })).toHaveProperty("forbidden");
    expect(await updateChatLogFeedback(env, rows[1].id, "good", { ltiCourseGrant: resource.courseId! })).toHaveProperty("forbidden");
    expect(await updateChatLogFeedback(env, rows[1].id, "good", { userId: "account-a" })).toMatchObject({ feedback: "good" });
  });

  it("enforces ownership on rotation and immediately revokes old or suspended credentials", async () => {
    expect(await rotateLmsSyncToken(env, "account-b", "moodle-a")).toBeNull();
    const rotated = await rotateLmsSyncToken(env, "account-a", "moodle-a");
    expect(await authenticateLmsInstallation(env, credential.token)).toBeNull();
    expect(await authenticateLmsInstallation(env, rotated!.token)).toHaveProperty("ownerUserId", "account-a");
    await pool.query("UPDATE users SET banned=true WHERE id='account-a'");
    expect(await authenticateLmsInstallation(env, rotated!.token)).toBeNull();
    expect((await resolvedLtiConfig(env))!.registrations).toHaveLength(0);
    expect((await request("connection", "GET", undefined, rotated!.token)).status).toBe(401);
  });

  it("revokes hidden lessons without retransferring or recharging them when reopened", async () => {
    const initial = await syncLmsResource(env, grant, "10", manifest());
    await pool.query("UPDATE videos SET status='completed'");
    const hidden = await syncLmsResource(env, grant, "10", manifest(2, { enabled: false }));
    expect(hidden.videoId).toBe(initial.videoId);
    expect((await resolvedLtiConfig(env))!.registrations[0].resources).toHaveLength(0);
    const reopened = await syncLmsResource(env, grant, "10", manifest(3));
    expect(reopened.videoId).toBe(initial.videoId);
    expect((await pool.query("SELECT used_upload_bytes::int FROM users WHERE id='account-a'")).rows[0].used_upload_bytes).toBe(3);
    expect((await resolvedLtiConfig(env))!.registrations[0].resources).toHaveLength(1);
  });
});
