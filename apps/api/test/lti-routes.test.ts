import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "../src/types/bindings";
import { ltiRoutes } from "../src/features/lti/routes";
import { securityHeaders } from "../src/middleware/security-headers";
import { createMemoryRateLimitBackend, setRateLimitBackendForTests } from "../src/lib/rate-limit";
import { appendCourseHistory, readCourseHistory } from "../src/features/lti/history";
import { digest } from "../src/features/lti/store";
import { verifyLaunch } from "../src/features/lti/protocol";
import { getVideoEvidence } from "../src/repositories/video-evidence-repository";
import { getCourseWithMembers, updateChatLogFeedback } from "../src/repositories/chat-repository";
import { sendChatMessage, streamChatMessage } from "../src/features/chat/message-service";

vi.mock("../src/features/lti/history", () => ({ appendCourseHistory: vi.fn(async () => {}), readCourseHistory: vi.fn(async () => []) }));

const records = vi.hoisted(() => new Map<string, { kind: string; payload: Record<string, unknown> }>());
vi.mock("../src/features/lti/store", async importOriginal => ({
  ...await importOriginal<typeof import("../src/features/lti/store")>(),
  putCredential: vi.fn((_env, id, kind, payload) => { records.set(id, { kind, payload }); }),
  readCredential: vi.fn((_env, id, kind) => records.get(id)?.kind === kind ? records.get(id)!.payload : null),
  recordScopeVideos: vi.fn((_env, id, ids: number[]) => {
    const record = records.get(id);
    if (!record || record.kind !== "session") return null;
    const used = [...new Set([...(record.payload.scopeVideoIds as number[] || []), ...ids])];
    record.payload.scopeVideoIds = used;
    return used;
  }),
  consumeLogin: vi.fn((_env, id) => records.get(id)?.kind === "login" && records.delete(id)),
}));
vi.mock("../src/features/lti/protocol", async importOriginal => ({
  ...await importOriginal<typeof import("../src/features/lti/protocol")>(), verifyLaunch: vi.fn(),
}));
vi.mock("../src/repositories/video-evidence-repository", () => ({ getVideoEvidence: vi.fn() }));
vi.mock("../src/repositories/chat-repository", () => ({ getCourseWithMembers: vi.fn(), updateChatLogFeedback: vi.fn() }));
vi.mock("../src/features/chat/message-service", () => ({ sendChatMessage: vi.fn(), streamChatMessage: vi.fn() }));
const resource = { deploymentId: "dep", contextId: "ctx", resourceLinkId: "res", courseId: 12, videoId: 1 };
const registration = {
  id: "moodle", issuer: "https://lms.example", clientId: "client",
  authorizationUrl: "https://lms.example/auth", jwksUrl: "https://lms.example/keys",
  frameOrigins: ["https://lms.example"], resources: [resource],
};
const config = { toolOrigin: "https://api.example", registrations: [registration] };
const env = { LTI_CONFIG: JSON.stringify(config) } as Bindings;
const app = new Hono<AppEnv>();
app.use("*", securityHeaders);
app.route("/api/lti", ltiRoutes);
const state = "a".repeat(64), secret = "b".repeat(64);
function request(path: string, data: unknown, token?: string, origin = "https://api.example", bindings = env) {
  return app.request("https://api.example/api/lti/" + path, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: JSON.stringify(data),
  }, bindings);
}
async function login() {
  records.set(state, { kind: "login", payload: {
    registrationId: "moodle", nonce: "nonce", browserHash: await digest(secret), target: "https://api.example/api/lti/launch",
  } });
}
async function session() {
  const response = await request("session", { state, browserSecret: secret, id_token: "signed-token" });
  expect(response.status).toBe(200);
  return (await response.json<{ token: string }>()).token;
}
beforeEach(async () => {
  vi.clearAllMocks(); records.clear(); await login();
  vi.mocked(readCourseHistory).mockResolvedValue([]);
  vi.mocked(verifyLaunch).mockResolvedValue({ ...resource, locale: "en", subject: "learner", roles: ["Learner"] });
  vi.mocked(getVideoEvidence).mockResolvedValue(null);
  vi.mocked(getCourseWithMembers).mockResolvedValue({ id: 12, userId: "owner", memberVideoIds: [1] });
  vi.mocked(updateChatLogFeedback).mockImplementation(async (_env, _id, feedback) => ({ id: 42, feedback }));
  vi.mocked(streamChatMessage).mockResolvedValue({ write: async send => {
    await send({ type: "text_delta", segmentIndex: 0, text: "回答" });
    await send({ type: "done", chat_log_id: 42, feedback: null });
  } });
  vi.mocked(sendChatMessage).mockResolvedValue({ status: 200, body: {
    role: "assistant", answer: { segments: [{ text: "回答", sourceIds: [] }], sources: [] }, chat_log_id: 42,
  } });
});
describe("LTI transport boundaries", () => {
  it("returns course history for the verified learner and reissues feedback without exposing log IDs", async () => {
    const token = await session();
    vi.mocked(readCourseHistory).mockResolvedValue([{ id: "d".repeat(32), logId: 42, question: "前の質問",
      answer: { segments: [{ text: "前の回答", sourceIds: [] }], sources: [] }, feedback: "good" }]);
    const response = await app.request("https://api.example/api/lti/history?courseId=999", {
      method: "POST",
      headers: { Origin: "https://api.example", Authorization: "Bearer " + token },
    }, env);
    expect(response.status).toBe(200);
    const body = await response.json<{ turns: { id: string; feedbackId: string; feedback: string }[] }>();
    expect(body.turns[0]).toMatchObject({ id: "d".repeat(32), feedback: "good" });
    expect(body.turns[0].feedbackId).toMatch(/^[a-f0-9]{64}$/);
    expect(body.turns[0]).not.toHaveProperty("logId");
    expect(readCourseHistory).toHaveBeenCalledWith(env, expect.objectContaining({ courseId: 12, subjectHash: expect.stringMatching(/^[a-f0-9]{64}$/) }), "owner", [1]);
    expect(appendCourseHistory).not.toHaveBeenCalled();
    expect((await app.request("https://api.example/api/lti/history", { method: "POST", headers: { Origin: "https://api.example" } }, env)).status).toBe(401);
  });
  it("allows 100 learners behind one school IP while limiting one learner independently", async () => {
    setRateLimitBackendForTests(createMemoryRateLimitBackend());
    const tokens: string[] = [];
    for (let index = 0; index < 100; index++) {
      await login();
      vi.mocked(verifyLaunch).mockResolvedValue({ ...resource, locale: "en", subject: "learner-" + index, roles: ["Learner"] });
      tokens.push(await session());
    }
    const ask = async (token: string) => app.request("https://api.example/api/lti/messages", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://api.example", Authorization: "Bearer " + token, "X-VideoQ-Client-IP": "192.0.2.1" },
      body: JSON.stringify({ messages: [{ role: "user", content: "教材について質問" }] }),
    }, { ...env, RUNTIME: "node" });
    for (let round = 0; round < 5; round++) {
      const responses = await Promise.all(tokens.map(ask));
      expect(responses.every(response => response.status === 200)).toBe(true);
    }
    for (let index = 5; index < 300; index++) expect((await ask(tokens[0])).status).toBe(200);
    expect((await ask(tokens[0])).status).toBe(429);
    expect((await ask(tokens[1])).status).toBe(200);
  });
  it("uses the trusted Node client IP for throttling rather than a supplied Cloudflare header", async () => {
    const backend = createMemoryRateLimitBackend();
    const consume = vi.spyOn(backend, "consume");
    setRateLimitBackendForTests(backend);
    const response = await app.request("https://api.example/api/lti/login", {
      headers: { "X-VideoQ-Client-IP": "127.0.0.1", "CF-Connecting-IP": "198.51.100.9" },
    }, { ...env, RUNTIME: "node" });
    expect(response.status).toBe(400);
    expect(consume).toHaveBeenCalledWith("throttle_lti_request_ip_127.0.0.1", 1200, 60, 1);
    expect(consume).toHaveBeenCalledWith("throttle_lti_launch_ip_127.0.0.1", 1200, 3600, 1);
  });
  it("is unavailable without explicit configuration", async () => {
    const response = await app.request("https://api.example/api/lti/login", {}, {});
    expect(response.status).toBe(404);
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });
  it("initiates OIDC with browser-bound storage and approved framing only", async () => {
    const params = new URLSearchParams({ iss: registration.issuer, client_id: "client", login_hint: "learner", target_link_uri: config.toolOrigin + "/api/lti/launch" });
    const response = await app.request("https://api.example/api/lti/login?" + params.toString(), {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors https://lms.example");
    expect(response.headers.has("X-Frame-Options")).toBe(false);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expect(await response.text()).toContain("sessionStorage.setItem");
  });
  it("rejects arbitrary target URLs", async () => {
    const response = await app.request("https://api.example/api/lti/login?" + new URLSearchParams({ iss: registration.issuer, login_hint: "learner", target_link_uri: "https://attacker.example" }).toString(), {}, env);
    expect(response.status).toBe(400);
  });
  it("requires browser possession and a same-origin exchange", async () => {
    expect((await request("session", { state, browserSecret: "c".repeat(64), id_token: "signed-token" })).status).toBe(401);
    expect((await request("session", { state, browserSecret: secret, id_token: "signed-token" }, undefined, "https://attacker.example")).status).toBe(403);
    expect(verifyLaunch).not.toHaveBeenCalled();
  });
  it("consumes login state once and stores only a hash of the session token", async () => {
    const token = await session();
    expect(records.has(state)).toBe(false);
    expect(records.has(token)).toBe(false);
    expect(records.has(await digest(token))).toBe(true);
    expect((await request("session", { state, browserSecret: secret, id_token: "signed-token" })).status).toBe(401);
  });
  it("allows only one concurrent exchange", async () => {
    const results = await Promise.all([1, 2].map(async () => request("session", { state, browserSecret: secret, id_token: "signed-token" })));
    expect(results.map(r => r.status).sort()).toEqual([200, 401]);
  });
  it("does not create a session for invalid claims or unavailable courses", async () => {
    vi.mocked(verifyLaunch).mockRejectedValueOnce(new Error("bad signature"));
    expect((await request("session", { state, browserSecret: secret, id_token: "signed-token" })).status).toBe(401);
    vi.mocked(getCourseWithMembers).mockResolvedValueOnce(null);
    expect((await request("session", { state, browserSecret: secret, id_token: "signed-token" })).status).toBe(403);
    expect(records.size).toBe(1);
  });
  it.each(["ja", "en"] as const)("passes the verified LMS locale %s to answer generation", async locale => {
    vi.mocked(verifyLaunch).mockResolvedValue({ ...resource, locale, subject: "learner", roles: ["Learner"] });
    const token = await session();
    expect((await request("messages", { messages: [{ role: "user", content: "Question" }] }, token)).status).toBe(200);
    expect(sendChatMessage).toHaveBeenCalledWith(env, expect.objectContaining({ locale }));
  });
  it("binds chat to its configured course and strips log metadata", async () => {
    const token = await session();
    const response = await request("messages", { messages: [{ role: "user", content: "質問" }] }, token);
    expect(response.status).toBe(200);
    expect(sendChatMessage).toHaveBeenCalledWith(env, expect.objectContaining({ userId: null, shareSlug: null, ltiCourseGrant: 12, body: { course_id: 12, messages: [{ role: "user", content: "質問" }] } }));
    expect(await response.json()).not.toHaveProperty("chat_log_id");
    expect((await request("messages", { course_id: 99, messages: [{ role: "user", content: "質問" }] }, token)).status).toBe(400);
  });
  it("attaches a validated playback hint only to the latest question", async () => {
    const token = await session();
    const response = await request("messages", {
      messages: [{ role: "user", content: "今の説明は？" }],
      playback: { video_id: 1, position_seconds: 10.9 },
    }, token);
    expect(response.status).toBe(200);
    expect(sendChatMessage).toHaveBeenCalledWith(env, expect.objectContaining({
      body: { course_id: 12, messages: [{ role: "user", content: expect.stringMatching(/動画ID 1、再生位置 00:00:10.*\n今の説明は？/) }] },
    }));
  });
  it("rejects playback for another video or a video removed from the course", async () => {
    const token = await session();
    expect((await request("messages", { messages: [{ role: "user", content: "質問" }], playback: { video_id: 2, position_seconds: 1 } }, token)).status).toBe(403);
    vi.mocked(getCourseWithMembers).mockResolvedValueOnce({ id: 12, userId: "owner", memberVideoIds: [] });
    expect((await request("messages", { messages: [{ role: "user", content: "質問" }], playback: { video_id: 1, position_seconds: 1 } }, token)).status).toBe(403);
    expect(sendChatMessage).not.toHaveBeenCalled();
  });
  it.each([-1, 604801, null])("rejects invalid playback seconds %j", async seconds => {
    const token = await session();
    expect((await request("messages", { messages: [{ role: "user", content: "質問" }], playback: { video_id: 1, position_seconds: seconds } }, token)).status).toBe(400);
    expect(sendChatMessage).not.toHaveBeenCalled();
  });
  it("does not create a playback grant for a video outside the bound course", async () => {
    vi.mocked(getCourseWithMembers).mockResolvedValueOnce({ id: 12, userId: "owner", memberVideoIds: [99] });
    expect((await request("session", { state, browserSecret: secret, id_token: "signed-token" })).status).toBe(403);
  });
  it("revokes sessions when a binding is removed", async () => {
    const token = await session();
    const bindings = { LTI_CONFIG: JSON.stringify({ ...config, registrations: [{ ...registration, resources: [{ ...resource, resourceLinkId: "different" }] }] }) } as Bindings;
    expect((await request("messages", { messages: [{ role: "user", content: "質問" }] }, token, "https://api.example", bindings)).status).toBe(403);
    expect(sendChatMessage).not.toHaveBeenCalled();
  });
  it("does not accept a session token as a browser login or grant arbitrary conversation access", async () => {
    expect((await request("messages", { messages: [{ role: "user", content: "質問" }] }, "d".repeat(64))).status).toBe(401);
    const token = await session();
    expect((await request("messages", { conversation_id: crypto.randomUUID(), messages: [{ role: "user", content: "質問" }] }, token)).status).toBe(400);
    expect(sendChatMessage).not.toHaveBeenCalled();
  });
});

describe("Moodle course permission checks", () => {
  const proof = { token: "aa." + "b".repeat(64), subject: "learner" };
  const bindings = { ...env, LTI_CONFIG: JSON.stringify({ ...config, registrations: [{ ...registration, courseAccess: "moodle", resources: [resource,
    { ...resource, resourceLinkId: "second", videoId: 2 },
    { ...resource, resourceLinkId: "hidden", videoId: 3 },
    { ...resource, contextId: "other-course", resourceLinkId: "other", courseId: 99, videoId: 4 },
  ] }] }) };
  async function scopedSession() {
    vi.mocked(verifyLaunch).mockResolvedValue({ ...resource, subject: "learner", roles: ["Learner"], locale: "ja", accessProof: proof });
    const response = await request("session", { state, browserSecret: secret, id_token: "signed-token" }, undefined, "https://api.example", bindings);
    expect(response.status).toBe(200);
    return response.json<{ token: string; playback: { videos: { videoId: number }[] } }>();
  }
  it("lists only current course materials and pages transcripts without exposing owner or storage fields", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ contextId: "ctx", resourceLinkId: "res", permissions: { viewTranscript: true },
      resources: ["res", "second", "other"].map(id => ({ resourceLinkId: id, lesson: id, title: "Moodle " + id })) }));
    try {
      const { token } = await scopedSession();
      vi.mocked(getCourseWithMembers).mockResolvedValue({ id: 12, userId: "owner", memberVideoIds: [1, 2] });
      vi.mocked(getVideoEvidence).mockResolvedValue({ id: 2, title: "Private VideoQ title", sourceType: "file", fileKey: "private/key",
        transcriptTooLarge: false, transcript: '1\n00:00:01,000 --> 00:00:02,000\n<img onerror="alert(1)">\n\n2\n00:00:03,000 --> 00:00:04,000\nNext cue' });
      const list = await request("materials", {}, token, "https://api.example", bindings);
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({ permissions: { viewTranscript: true }, videos: [
        { videoId: 1, lesson: "res", title: "Moodle res" }, { videoId: 2, lesson: "second", title: "Moodle second" },
      ] });
      const transcript = await request("transcript", { videoId: 2, limit: 1 }, token, "https://api.example", bindings);
      expect(transcript.status).toBe(200);
      expect(await transcript.json()).toEqual({ videoId: 2, title: "Moodle second", nextCursor: 1,
        cues: [{ startTime: "00:00:01,000", startSeconds: 1, endSeconds: 2, text: '<img onerror="alert(1)">' }] });
      expect(getVideoEvidence).toHaveBeenLastCalledWith(bindings, { ownerUserId: "owner", videoIds: [2] }, 2);
      const next = await request("transcript", { videoId: 2, cursor: 1, limit: 1 }, token, "https://api.example", bindings);
      expect(await next.json()).toMatchObject({ cues: [{ text: "Next cue" }], nextCursor: null });
      expect((await request("transcript", { videoId: 3 }, token, "https://api.example", bindings)).status).toBe(403);
      expect((await request("transcript", { videoId: 4 }, token, "https://api.example", bindings)).status).toBe(403);
      expect((await request("transcript", { videoId: 2, courseId: 99 }, token, "https://api.example", bindings)).status).toBe(400);
      expect((await request("materials", {}, token, "https://attacker.example", bindings)).status).toBe(403);
      vi.mocked(getCourseWithMembers).mockResolvedValue({ id: 12, userId: "owner", memberVideoIds: [1] });
      expect((await request("transcript", { videoId: 2 }, token, "https://api.example", bindings)).status).toBe(403);
    } finally { fetch.mockRestore(); }
  });
  it("revokes transcript capabilities and resource visibility during an existing session", async () => {
    let permitted = true, visible = true;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ contextId: "ctx", resourceLinkId: "res",
      permissions: { viewTranscript: permitted }, resources: (visible ? ["res", "second"] : ["res"]).map(id => ({ resourceLinkId: id, lesson: id, title: id })) }));
    try {
      const { token } = await scopedSession();
      vi.mocked(getCourseWithMembers).mockResolvedValue({ id: 12, userId: "owner", memberVideoIds: [1, 2] });
      vi.mocked(getVideoEvidence).mockResolvedValue({ id: 2, title: "", sourceType: "file", fileKey: null, transcript: "", transcriptTooLarge: false });
      expect((await request("transcript", { videoId: 2 }, token, "https://api.example", bindings)).status).toBe(200);
      vi.mocked(getVideoEvidence).mockClear();
      permitted = false;
      expect((await request("transcript", { videoId: 2 }, token, "https://api.example", bindings)).status).toBe(403);
      expect(getVideoEvidence).not.toHaveBeenCalled();
      permitted = true; visible = false;
      expect((await request("transcript", { videoId: 2 }, token, "https://api.example", bindings)).status).toBe(403);
      fetch.mockRejectedValue(new Error("Moodle offline"));
      expect((await request("materials", {}, token, "https://api.example", bindings)).status).toBe(403);
    } finally { fetch.mockRestore(); }
  });
  it("never grants transcript access from Instructor roles, missing capabilities, or an unchecked registration", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ contextId: "ctx", resourceLinkId: "res",
      resources: [{ resourceLinkId: "res", lesson: "res", title: "Lesson" }] }));
    try {
      const { token } = await scopedSession();
      // A browser or launch role cannot supply the server's missing capability.
      records.get(await digest(token))!.payload.roles = ["Instructor", "Administrator"];
      expect((await request("transcript", { videoId: 1 }, token, "https://api.example", bindings)).status).toBe(403);
      expect(getVideoEvidence).not.toHaveBeenCalled();
      await login();
      vi.mocked(verifyLaunch).mockResolvedValue({ ...resource, locale: "en", subject: "teacher", roles: ["Instructor"] });
      const unchecked = await session();
      expect((await request("materials", {}, unchecked)).status).toBe(403);
      expect((await request("transcript", { videoId: 1 }, unchecked)).status).toBe(403);
    } finally { fetch.mockRestore(); }
  });
  it("rechecks visibility before each question and scopes retrieval/playback to allowed videos", async () => {
    let allowed = ["res", "second", "other"];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      expect(url).toBe("https://lms.example/local/videoq/access.php");
      expect(options?.redirect).toBe("error");
      expect(JSON.parse(options!.body as string)).toMatchObject({ ...proof, contextId: "ctx", resourceLinkId: "res" });
      return Response.json({ contextId: "ctx", resourceLinkId: "res", resources: allowed.map(id => ({ resourceLinkId: id, lesson: id, title: id })) });
    });
    try {
      const session = await scopedSession();
      expect(session.playback.videos.map(video => video.videoId)).toEqual([1, 2]);
      vi.mocked(getCourseWithMembers).mockResolvedValue({ id: 12, userId: "owner", memberVideoIds: [1, 2] });
      const body = { messages: [{ role: "user", content: "両方の動画を比べて" }], playback: { video_id: 2, position_seconds: 8 } };
      expect((await request("messages", body, session.token, "https://api.example", bindings)).status).toBe(200);
      expect(sendChatMessage).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ ltiCourseGrant: 12, ltiVideoGrant: [1, 2] }));
      expect((await request("messages", { ...body, playback: { video_id: 3, position_seconds: 8 } }, session.token, "https://api.example", bindings)).status).toBe(403);
      allowed = ["res"];
      expect((await request("messages", body, session.token, "https://api.example", bindings)).status).toBe(403);
      expect((await request("messages", { messages: [{ role: "user", content: "旧質問" }, { role: "assistant", content: "以前の教材の回答" }, { role: "user", content: "講座を説明して" }] }, session.token, "https://api.example", bindings)).status).toBe(200);
      expect(sendChatMessage).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ ltiVideoGrant: [1], body: { course_id: 12, messages: [{ role: "user", content: "講座を説明して" }] } }));
      // Reallow and revoke a video again: old client history must never reintroduce it.
      allowed = ["res", "second", "hidden"];
      expect((await request("messages", { messages: body.messages }, session.token, "https://api.example", bindings)).status).toBe(200);
      allowed = ["res", "second"];
      expect((await request("messages", { messages: [{ role: "user", content: "旧質問" }, { role: "assistant", content: "一時的に公開されていた動画の回答" }, { role: "user", content: "今の講座を説明して" }] }, session.token, "https://api.example", bindings)).status).toBe(200);
      expect(sendChatMessage).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ body: { course_id: 12, messages: [{ role: "user", content: "今の講座を説明して" }] } }));
      fetch.mockRejectedValue(new Error("Moodle unavailable"));
      const calls = vi.mocked(sendChatMessage).mock.calls.length;
      expect((await request("messages", { messages: body.messages }, session.token, "https://api.example", bindings)).status).toBe(403);
      expect(vi.mocked(sendChatMessage).mock.calls).toHaveLength(calls);
    } finally { fetch.mockRestore(); }
  });
});


describe("LTI streaming and feedback", () => {
  it("flushes actual stream events before completion and conceals owner log identifiers", async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(streamChatMessage).mockResolvedValue({ write: async send => {
      await send({ type: "text_delta", segmentIndex: 0, text: "最初の部分" });
      await hold;
      await send({ type: "text_delta", segmentIndex: 0, text: "、続きです。" });
      await send({ type: "done", chat_log_id: 42, feedback: null });
    } });
    const token = await session();
    const response = await request("messages/stream", { messages: [{ role: "user", content: "講座の質問" }] }, token);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream; charset=utf-8");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("最初の部分"); expect(first).not.toContain('"done"');
    release();
    let rest = "";
    for (;;) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); }
    expect(rest).toContain("続きです。"); expect(rest).toContain('"feedbackId"');
    expect(rest).not.toContain("chat_log_id");
    expect(streamChatMessage).toHaveBeenCalledWith(env, expect.objectContaining({ userId: null, ltiCourseGrant: 12, body: { messages: [{ role: "user", content: "講座の質問" }], course_id: 12 }, clientSignal: expect.any(AbortSignal) }));
  });
  it("saves, changes and clears feedback only for the answer's originating session", async () => {
    const token = await session();
    const answer = await request("messages", { messages: [{ role: "user", content: "質問" }] }, token);
    const { feedbackId } = await answer.json<{ feedbackId: string }>();
    expect(feedbackId).toMatch(/^[a-f0-9]{64}$/);
    for (const feedback of ["good", "bad", null] as const) {
      const response = await request("feedback", { feedbackId, feedback }, token);
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ feedback });
      expect(updateChatLogFeedback).toHaveBeenLastCalledWith(env, 42, feedback, { ltiCourseGrant: 12 });
    }
    const calls = vi.mocked(updateChatLogFeedback).mock.calls.length;
    expect((await request("feedback", { feedbackId: "f".repeat(64), feedback: "good" }, token)).status).toBe(403);
    expect((await request("feedback", { feedbackId, feedback: "good", logId: 99 }, token)).status).toBe(400);
    await login(); const otherSession = await session();
    expect((await request("feedback", { feedbackId, feedback: "good" }, otherSession)).status).toBe(403);
    const revoked = { ...env, LTI_CONFIG: JSON.stringify({ ...config, registrations: [{ ...registration, resources: [{ ...resource, videoId: 99 }] }] }) };
    expect((await request("feedback", { feedbackId, feedback: "bad" }, token, "https://api.example", revoked)).status).toBe(403);
    expect(vi.mocked(updateChatLogFeedback).mock.calls).toHaveLength(calls);
  });
  it("applies the same authorization and input boundaries to streaming questions", async () => {
    const token = await session();
    expect((await request("messages/stream", { messages: [{ role: "user", content: "質問" }] }, token, "https://attacker.example")).status).toBe(403);
    expect((await request("messages/stream", { messages: [{ role: "user", content: "質問" }], course_id: 99 }, token)).status).toBe(400);
    expect(streamChatMessage).not.toHaveBeenCalled();
  });
});
