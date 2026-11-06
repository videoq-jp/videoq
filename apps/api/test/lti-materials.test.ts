import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from "jose";
import { toolClientAssertion, toolJwks } from "../src/features/lti/tool-keys";
import { MaterialsClient, MATERIALS_SCOPE } from "../src/features/lti/materials-client";
import { courseAccessContext } from "../src/features/lti/course-access";
import type { Bindings } from "../src/types/bindings";
let env: { LTI_TOOL_KEYS: string };
const registration = { clientId: "tool-client", deploymentId: "deployment-7",
  materialsService: { tokenEndpoint: "https://moodle.example/local/videoq/token.php", endpoint: "https://moodle.example/local/videoq/materials.php" } };
beforeAll(async () => {
  const current = await generateKeyPair("RS256", { extractable: true });
  const previous = await generateKeyPair("RS256", { extractable: true });
  env = { LTI_TOOL_KEYS: JSON.stringify({ current: await exportJWK(current.privateKey), previous: [await exportJWK(previous.publicKey)] }) };
});
describe("LTI tool service credentials", () => {
  it("publishes only public components, preserving retired keys during rotation", async () => {
    const jwks = await toolJwks(env);
    expect(jwks.keys).toHaveLength(2);
    expect(jwks.keys.every(key => Object.keys(key).sort().join() === "alg,e,kid,kty,n,use")).toBe(true);
    const first = await toolClientAssertion(env, registration.clientId, registration.deploymentId, registration.materialsService.tokenEndpoint);
    const second = await toolClientAssertion(env, registration.clientId, registration.deploymentId, registration.materialsService.tokenEndpoint);
    const keys = createLocalJWKSet(jwks);
    const { payload } = await jwtVerify(first, keys, { issuer: registration.clientId,
      audience: registration.materialsService.tokenEndpoint, algorithms: ["RS256"] });
    expect(payload.sub).toBe(registration.clientId);
    expect(payload.exp! - payload.iat!).toBe(60);
    expect(payload["https://purl.imsglobal.org/spec/lti/claim/deployment_id"]).toBe(registration.deploymentId);
    expect((await jwtVerify(second, keys)).payload.jti).not.toBe(payload.jti);
    await expect(jwtVerify(first, keys, { audience: "https://wrong.example/token" })).rejects.toThrow();
  });
  it("does not echo invalid secret configuration", async () => {
    await expect(toolJwks({ LTI_TOOL_KEYS: "private-key-secret" })).rejects.toThrow("Invalid LTI tool signing-key configuration");
  });
});
function mockService(result: unknown, tokenOverride = {}) {
  return vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    if (input === registration.materialsService.tokenEndpoint) {
      expect(init?.redirect).toBe("error");
      const form = init?.body as URLSearchParams;
      expect(form.get("scope")).toBe(MATERIALS_SCOPE);
      await jwtVerify(form.get("client_assertion")!, createLocalJWKSet(await toolJwks(env)),
        { audience: registration.materialsService.tokenEndpoint, issuer: registration.clientId });
      return Response.json({ access_token: "ephemeral", token_type: "Bearer", expires_in: 60, scope: MATERIALS_SCOPE, ...tokenOverride });
    }
    expect(input).toBe(registration.materialsService.endpoint);
    expect(init?.redirect).toBe("error");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer ephemeral");
    return Response.json(result);
  });
}
describe("LTI materials service boundary", () => {
  it.each([true, false, undefined])("uses current materials-service permissions (%j) and opts in to the extended response", async viewTranscript => {
    const result = { contextId: "course", resourceLinkId: "launch", ...(viewTranscript === undefined ? {} : { permissions: { viewTranscript, futureCapability: true } }),
      resources: [{ externalId: "cm-1", resourceLinkId: "launch", lesson: "lesson-1", title: "First" },
        { externalId: "cm-2", resourceLinkId: "other-course", lesson: "other", title: "Other course" }] };
    const request = mockService(result);
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(request);
    try {
      const binding = { deploymentId: registration.deploymentId, contextId: "course", resourceLinkId: "launch", courseId: 1, videoId: 10 };
      const reg = { ...registration, id: "moodle", issuer: "https://moodle.example", authorizationUrl: "https://moodle.example/auth",
        jwksUrl: "https://moodle.example/keys", frameOrigins: ["https://moodle.example"], resources: [binding,
          { ...binding, contextId: "other-course", resourceLinkId: "other-course", courseId: 2, videoId: 20 }] };
      const access = await courseAccessContext(reg, { ...binding, serviceSubject: "student" }, env as Bindings);
      expect(access).toEqual({ videos: [{ videoId: 10, lesson: "lesson-1", title: "First" }], permissions: {
        manageOwnHistory: false, viewTranscript: viewTranscript ?? false, viewQa: false, postQa: false, voteQa: false,
        deleteOwnQa: false, moderateQa: false, instructorQa: false,
      } });
      expect(JSON.parse(request.mock.calls[1][1]!.body as string)).toEqual({ action: "access", contextId: "course",
        resourceLinkId: "launch", subject: "student", includePermissions: true });
      await expect(courseAccessContext(reg, binding, env as Bindings)).rejects.toThrow("service access required");
    } finally { spy.mockRestore(); }
  });
  it("accepts an explicit empty snapshot without inventing deletions", async () => {
    const snapshot = { contextId: "course", complete: true, resources: [] };
    expect(await new MaterialsClient(env, registration, mockService(snapshot)).manifest("course")).toEqual(snapshot);
  });
  it.each([
    { contextId: "other", complete: true, resources: [] },
    { contextId: "course", complete: false, resources: [] },
    { contextId: "course", complete: true, resources: [{ externalId: "v", manifest: { contextId: "other", resourceLinkId: "l", generation: 1, title: "x", enabled: false } }] },
  ])("rejects incomplete or cross-course manifests", async snapshot => {
    await expect(new MaterialsClient(env, registration, mockService(snapshot)).manifest("course")).rejects.toThrow();
  });
  it("rejects a service token with a different scope before calling the service", async () => {
    const request = mockService({}, { scope: "other" });
    await expect(new MaterialsClient(env, registration, request).manifest("course")).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("requires export status to match both job and source generation", async () => {
    const request = mockService({ jobId: "a".repeat(32), generation: 2, status: "uploaded", bytes: 30 });
    await expect(new MaterialsClient(env, registration, request).exportStatus("course", "b".repeat(32), 2)).rejects.toThrow();
    await expect(new MaterialsClient(env, registration, request).startExport("course", "v", 1, "https://storage.example/upload", "id")).rejects.toThrow();
  });
  it("rejects a response exceeding its byte budget", async () => {
    const request = mockService({ padding: "x".repeat(1024 * 1024) });
    await expect(new MaterialsClient(env, registration, request).manifest("course")).rejects.toThrow("too large");
  });
});


describe("materials connection setup", () => {
  it("uses a distinct mode and rejects a separately supplied sync key", async () => {
    const { pairingExchangeSchema } = await import("../src/features/lms/pairing");
    const input = { secret: "a".repeat(64), issuer: "https://moodle.example", clientId: "client", deploymentId: "7", mode: "materials", materialsService: registration.materialsService };
    expect(pairingExchangeSchema.safeParse(input).success).toBe(true);
    expect(pairingExchangeSchema.safeParse({ ...input, syncToken: "b".repeat(64) }).success).toBe(false);
    expect(pairingExchangeSchema.safeParse({ ...input, mode: "legacy" }).success).toBe(false);
  });
});


it("does not synchronize when the global LTI database integration is disabled", async () => {
  const { sweepMaterials } = await import("../src/features/lti/materials-sync");
  expect(await sweepMaterials({ LTI_TOOL_KEYS: "configured" } as import("../src/types/bindings").Bindings)).toEqual({ synchronized: 0 });
});

it.each([
  { LTI_TOOL_KEYS: "configured", USE_S3_STORAGE: "true" },
  { LTI_CONFIG: '{"toolOrigin":"https://api.example","databaseRegistrations":true,"registrations":[]}', USE_S3_STORAGE: "true" },
  { LTI_CONFIG: '{"toolOrigin":"https://api.example","databaseRegistrations":true,"registrations":[]}', LTI_TOOL_KEYS: "configured", USE_S3_STORAGE: "false" },
])("does not poll a partially configured materials deployment", async settings => {
  const { sweepMaterials } = await import("../src/features/lti/materials-sync");
  expect(await sweepMaterials(settings as import("../src/types/bindings").Bindings)).toEqual({ synchronized: 0 });
});
