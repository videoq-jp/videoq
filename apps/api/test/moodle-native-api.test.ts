import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "../src/types/bindings";
import type { LtiRegistration } from "../src/features/lti/config";
import { moodleNativeRoutes } from "../src/features/lms/native-routes";
import { authorizeNativeRequest, verifyNativeAssertion } from "../src/features/lms/native-auth";
import { ensureNativeSession } from "../src/features/lms/native-session";
import { courseAccessContext } from "../src/features/lti/course-access";
import { deniedCoursePermissions } from "../src/features/lti/course-permissions";
import { resolvedLtiConfig } from "../src/features/lti/registrations";
import { getCourseWithMembers } from "../src/repositories/chat-repository";
import { getVideoEvidence } from "../src/repositories/video-evidence-repository";
import { digest } from "../src/features/lti/store";
import { manageLtiMaterial } from "../src/features/lti/material-management";
import { createMemoryRateLimitBackend, setRateLimitBackendForTests } from "../src/lib/rate-limit";

const keyState = vi.hoisted(() => ({ keys: undefined as JWTVerifyGetKey | undefined }));
vi.mock("../src/features/lti/registrations", () => ({ resolvedLtiConfig: vi.fn() }));
vi.mock("../src/features/lti/course-access", () => ({ courseAccessContext: vi.fn() }));
vi.mock("../src/repositories/chat-repository", () => ({ getCourseWithMembers: vi.fn(), updateChatLogFeedback: vi.fn() }));
vi.mock("../src/repositories/video-evidence-repository", () => ({ getVideoEvidence: vi.fn() }));
vi.mock("../src/features/lms/native-session", () => ({ ensureNativeSession: vi.fn(async () => {}) }));
vi.mock("../src/features/lti/material-management", async original => ({
  ...await original<typeof import("../src/features/lti/material-management")>(), manageLtiMaterial: vi.fn(),
}));
vi.mock("../src/features/lti/protocol", async original => ({
  ...await original<typeof import("../src/features/lti/protocol")>(),
  platformKeys: () => { if (!keyState.keys) throw new Error("Test keys unavailable"); return keyState.keys; },
}));

const origin = "https://api.example";
const reg: LtiRegistration = {
  id: "db:school", issuer: "https://moodle.example", clientId: "client", deploymentId: "2",
  authorizationUrl: "https://moodle.example/auth", jwksUrl: "https://moodle.example/keys",
  frameOrigins: ["https://moodle.example"],
  materialsService: { tokenEndpoint: "https://moodle.example/token", endpoint: "https://moodle.example/materials" },
  resources: [
    { kind: "course", deploymentId: "2", contextId: "42", resourceLinkId: "entry", courseId: 12, generation: 1 },
    { deploymentId: "2", contextId: "42", resourceLinkId: "material3", courseId: 12, videoId: 3, generation: 1 },
  ],
};
const env = { LTI_CONFIG: JSON.stringify({ toolOrigin: origin, databaseRegistrations: true, registrations: [] }) } as Bindings;
const current = { videos: [{ videoId: 3, lesson: "lesson3", title: "Lesson" }],
  permissions: { ...deniedCoursePermissions, manageOwnHistory: true, viewTranscript: true, viewQa: true } };
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let sessionStartedAt: number;
const app = new Hono<AppEnv>().route("/api/lms/native", moodleNativeRoutes);

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  privateKey = keys.privateKey;
  keyState.keys = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: "platform-key", alg: "RS256" }] });
});
beforeEach(() => {
  vi.clearAllMocks();
  sessionStartedAt = Math.floor(Date.now() / 1000) - 5;
  setRateLimitBackendForTests(createMemoryRateLimitBackend());
  vi.mocked(resolvedLtiConfig).mockResolvedValue({ toolOrigin: origin, databaseRegistrations: true, registrations: [reg] });
  vi.mocked(courseAccessContext).mockResolvedValue(structuredClone(current));
  vi.mocked(getCourseWithMembers).mockResolvedValue({ id: 12, userId: "owner", memberVideoIds: [3] });
  vi.mocked(getVideoEvidence).mockResolvedValue({ id: 3, title: "Lesson", transcriptTooLarge: false,
    transcript: "1\n00:00:00,000 --> 00:00:01,000\nOriginal lesson\n" });
});

async function assertion(operation = "/materials", body = "{}", extra: Record<string, unknown> = {}, typ = "videoq-native+jwt") {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: reg.issuer, sub: reg.clientId, aud: origin + "/api/lms/native" + operation,
    deploymentId: "2", subject: "11", contextId: "42", resourceLinkId: "entry", sessionId: "b".repeat(64),
    sessionStartedAt, sessionExpiresAt: sessionStartedAt + 3505, iat: now, exp: now + 60,
    locale: "ja", version: 1, jti: crypto.randomUUID(), bodySha256: await digest(body), ...extra,
  }).setProtectedHeader({ alg: "RS256", kid: "platform-key", typ }).sign(privateKey);
}
async function request(operation = "/materials", body = "{}", headers: Record<string, string> = {}) {
  const jwt = await assertion(operation, body);
  return app.request(origin + "/api/lms/native" + operation, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt, ...headers }, body }, env);
}

describe("Moodle server-authenticated learning API", () => {
  it("returns course data through the shared handlers without exposing a session bearer", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.videos).toEqual(current.videos);
    expect(body.permissions).toEqual(current.permissions);
    expect(body.nativeProtocol).toBe(1);
    expect(body.features).toMatchObject({ conversations: true, qa: true, management: true });
    expect(JSON.stringify(body)).not.toMatch(/subjectHash|sessionId|registrationHash|Bearer|owner/);
    expect(ensureNativeSession).toHaveBeenCalledOnce();
    expect(courseAccessContext).toHaveBeenCalledOnce();
    expect(getCourseWithMembers).toHaveBeenCalledOnce();
  });

  it("checks the original JSON bytes before a shared handler parses them", async () => {
    const body = '{"videoId":3, "cursor":0, "limit":50}';
    const response = await request("/transcript", body);
    expect(response.status).toBe(200);
    expect((await response.json()).cues[0].text).toBe("Original lesson");
  });

  it("passes a teacher edit to the common material service with a server-derived scope", async () => {
    vi.mocked(courseAccessContext).mockResolvedValue({ ...structuredClone(current),
      permissions: { ...current.permissions, manageContent: true },
      managementVideos: [{ videoId: 3, lesson: "lesson3", title: "Lesson", management: { generation: 1 } }],
    });
    vi.mocked(manageLtiMaterial).mockResolvedValue({ material: { videoId: 3, title: "Lesson", description: "Original",
      transcript: "", status: "completed", revision: "a".repeat(64), canEdit: true, canReindex: true,
      canRetry: false, jobState: "completed" }, externalTaskId: null, reused: false });
    const response = await request("/management", '{"action":"get", "videoId":3}');
    expect(response.status).toBe(200);
    expect(manageLtiMaterial).toHaveBeenCalledWith(env, expect.objectContaining({
      installationId: "school", ownerUserId: "owner", courseId: 12, resourceLinkId: "material3", videoId: 3, generation: 1,
    }), { action: "get", videoId: 3 });
    expect((await response.json()).material.description).toBe("Original");
  });

  it("keeps the established LTI subject identity and separates users and Moodle sessions", async () => {
    const sha = await digest("{}");
    const first = await authorizeNativeRequest(env, await assertion(), "/materials", sha);
    const again = await authorizeNativeRequest(env, await assertion(), "/materials", sha);
    const peer = await authorizeNativeRequest(env, await assertion("/materials", "{}", { subject: "22" }), "/materials", sha);
    const newSession = await authorizeNativeRequest(env, await assertion("/materials", "{}", { sessionId: "c".repeat(64) }), "/materials", sha);
    expect(first.grant.subjectHash).toBe(await digest(JSON.stringify([reg.issuer, reg.clientId, "2", "11"])));
    expect(first.sessionHash).toBe(again.sessionHash);
    expect(peer.sessionHash).not.toBe(first.sessionHash);
    expect(newSession.sessionHash).not.toBe(first.sessionHash);
    expect(first.grant.serviceSubject).toBe("11");
    expect(first.grant.roles).toEqual([]);
    expect(first.grant.transport).toBe("native");
  });

  it.each([
    { iss: "https://unregistered.invalid" }, { sub: "other-client" }, { deploymentId: "other-deployment" },
    { aud: origin + "/api/lms/privacy" }, { version: 2 }, { roles: ["Administrator"] },
    { permissions: { manageContent: true } }, { ownerUserId: "owner" }, { courseId: 12 },
    { bodySha256: "f".repeat(64) }, { sessionId: "short" },
  ])("rejects an altered trust or authority field: %j", async extra => {
    await expect(verifyNativeAssertion(env, await assertion("/materials", "{}", extra), "/materials", await digest("{}"), keyState.keys))
      .rejects.toMatchObject({ status: 403 });
    expect(ensureNativeSession).not.toHaveBeenCalled();
    expect(courseAccessContext).not.toHaveBeenCalled();
  });

  it("binds the signature to the endpoint and exact request body", async () => {
    const signed = await assertion();
    await expect(verifyNativeAssertion(env, signed, "/qa", await digest("{}"), keyState.keys)).rejects.toMatchObject({ status: 403 });
    await expect(verifyNativeAssertion(env, signed, "/materials", await digest("{ }"), keyState.keys)).rejects.toMatchObject({ status: 403 });
    await expect(verifyNativeAssertion(env, await assertion("/materials", "{}", {}, "videoq-privacy+jwt"), "/materials", await digest("{}"), keyState.keys))
      .rejects.toMatchObject({ status: 403 });
  });

  it("rejects stale, future, overlong assertions and invalid session lifetimes", async () => {
    const now = Math.floor(Date.now() / 1000);
    // Keep claim relationships fixed if signing crosses a second boundary.
    for (const extra of [{ iat: now - 80, exp: now - 20, sessionStartedAt: now - 100 },
      { iat: now + 20, exp: now + 60 }, { exp: now + 61 },
      { sessionStartedAt: now + 1 }, { sessionStartedAt: now - 200, sessionExpiresAt: now + 3500 }]) {
      await expect(verifyNativeAssertion(env, await assertion("/materials", "{}", { iat: now, ...extra }), "/materials", await digest("{}"), keyState.keys))
        .rejects.toMatchObject({ status: 403 });
    }
    await expect(verifyNativeAssertion(env, "x".repeat(16385), "/materials", await digest("{}"), keyState.keys)).rejects.toMatchObject({ status: 403 });
  });

  it("verifies the platform signature with its registered key", async () => {
    const other = await generateKeyPair("RS256");
    const wrong = createLocalJWKSet({ keys: [{ ...await exportJWK(other.publicKey), kid: "platform-key", alg: "RS256" }] });
    await expect(verifyNativeAssertion(env, await assertion(), "/materials", await digest("{}"), wrong)).rejects.toMatchObject({ status: 403 });
  });

  it("denies revoked Moodle access and inactive VideoQ ownership before creating a data session", async () => {
    vi.mocked(courseAccessContext).mockRejectedValueOnce(new Error("Revoked"));
    expect((await request()).status).toBe(403);
    expect(ensureNativeSession).not.toHaveBeenCalled();
    vi.mocked(getCourseWithMembers).mockResolvedValueOnce(null);
    expect((await request()).status).toBe(403);
    expect(ensureNativeSession).not.toHaveBeenCalled();
  });

  it("rejects browser-origin requests, unsigned requests, unknown operations and oversized input", async () => {
    for (const Origin of [origin, reg.issuer, "https://untrusted.invalid"]) expect((await request("/materials", "{}", { Origin })).status).toBe(403);
    expect((await app.request(origin + "/api/lms/native/materials", { method: "POST", body: "{}" }, env)).status).toBe(401);
    expect((await request("/privacy")).status).toBe(404);
    expect((await request("/materials", "x".repeat(128 * 1024 + 1))).status).toBe(413);
    expect(ensureNativeSession).not.toHaveBeenCalled();
  });

});
