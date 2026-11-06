import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from "jose";
import { toolClientAssertion, toolJwks } from "../src/features/lti/tool-keys";
import { MaterialsClient, MATERIALS_SCOPE, materialsManifestSchema } from "../src/features/lti/materials-client";
import { resourceManifestSchema } from '../src/features/lms/resource';
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
      expect(access).toEqual({ videos: [{ videoId: 10, lesson: "lesson-1", title: "First" }], materialOrder: [10], permissions: {
        manageContent: false, manageOwnHistory: false, viewTranscript: viewTranscript ?? false, viewQa: false, postQa: false, voteQa: false,
        deleteOwnQa: false, moderateQa: false, instructorQa: false,
      } });
      expect(JSON.parse(request.mock.calls[1][1]!.body as string)).toEqual({ action: "access", contextId: "course",
        resourceLinkId: "launch", subject: "student", includePermissions: true, includeContentManagement: true, includeCourseEntries: true, includeUserVisibility: true, includeReports: true });
      await expect(courseAccessContext(reg, binding, env as Bindings)).rejects.toThrow("service access required");
    } finally { spy.mockRestore(); }
  });
  it("accepts an explicit empty snapshot without inventing deletions", async () => {
    const snapshot = { contextId: "course", complete: true, resources: [] };
    expect(await new MaterialsClient(env, registration, mockService(snapshot)).manifest("course")).toEqual(snapshot);
  });
  it('preserves current Moodle order across readable and management-only resources without adding foreign or stale sources', async () => {
    const base = { deploymentId: registration.deploymentId, contextId: '42', courseId: 1, generation: 2 };
    const resources = [
      { ...base, resourceLinkId: 'ready', videoId: 10, learningAvailable: true },
      { ...base, resourceLinkId: 'pending', videoId: 20, learningAvailable: false },
      { ...base, resourceLinkId: 'readonly', videoId: 30, learningAvailable: true },
      { ...base, resourceLinkId: 'foreign', videoId: 40, contextId: 'other', courseId: 2 },
    ];
    const reg = { ...registration, id: 'db:school', issuer: 'https://moodle.example', authorizationUrl: 'https://moodle.example/auth',
      jwksUrl: 'https://moodle.example/keys', frameOrigins: ['https://moodle.example'], resources };
    const entries = [
      { externalId: '2', resourceLinkId: 'pending', lesson: 'second', title: 'Pending', generation: 2, learning: false, management: { generation: 2 } },
      { externalId: '3', resourceLinkId: 'readonly', lesson: 'third', title: 'Read only', generation: 2 },
      { externalId: '1', resourceLinkId: 'ready', lesson: 'first', title: 'Ready', generation: 2, management: { generation: 2 } },
      { externalId: '4', resourceLinkId: 'foreign', lesson: 'foreign', title: 'Foreign', generation: 2 },
      { externalId: '5', resourceLinkId: 'ready', lesson: 'stale', title: 'Stale', generation: 1 },
    ];
    let ordered = entries;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => mockService({ contextId: '42', resourceLinkId: 'ready',
      permissions: { manageContent: true }, resources: ordered })(input, init));
    const get = () => courseAccessContext(reg, { ...resources[0], resourceGeneration: 2, serviceSubject: 'teacher' }, env as Bindings);
    try {
      const first = await get();
      expect(first?.videos.map(video => video.videoId)).toEqual([30, 10]);
      expect(first?.managementVideos?.map(video => video.videoId)).toEqual([20, 10]);
      expect(first?.materialOrder).toEqual([20, 30, 10]);
      ordered = [entries[2], entries[0], entries[1], entries[3], entries[4]];
      expect((await get())?.materialOrder).toEqual([10, 20, 30]);
    } finally { spy.mockRestore(); }
  });
  it('preserves the canonical video manifest shape while rejecting files or enabled tombstones on course entries', () => {
    const old = { generation: 1, contextId: '42', resourceLinkId: 'lesson', enabled: true, title: 'Lesson',
      file: { filename: 'lesson.mp4',contentType: 'video/mp4',size: 3,contentHash: 'a'.repeat(40) } };
    expect(JSON.stringify(resourceManifestSchema.parse(old))).toBe(JSON.stringify(old));
    const entry = { ...old,kind: 'course',file: undefined };
    expect(resourceManifestSchema.safeParse(entry).success).toBe(true);
    expect(resourceManifestSchema.safeParse({ ...entry,file: old.file }).success).toBe(false);
    expect(resourceManifestSchema.safeParse({ ...entry,deleted: true }).success).toBe(false);
    const resources = Array.from({length:1000}, (_, i) => ({ externalId: String(i+1),manifest: old }));
    const snapshot = { contextId: '42',complete: true,resources: [...resources,{ externalId: 'course_42',manifest: entry }] };
    expect(materialsManifestSchema.safeParse(snapshot).success).toBe(true);
    expect(materialsManifestSchema.safeParse({ ...snapshot,resources: [...resources,{ externalId: 'more',manifest: old }] }).success).toBe(false);
    expect(materialsManifestSchema.safeParse({ ...snapshot,resources: [{externalId:'a',manifest:entry},{externalId:'b',manifest:entry}] }).success).toBe(false);
  });
  it.each([
    { database: true, kind: true, generation: 2, launchGeneration: 2, proofGeneration: 2, allowed: true },
    { database: false, kind: true, generation: 2, launchGeneration: 2, proofGeneration: 2, allowed: false },
    { database: true, kind: false, generation: 2, launchGeneration: 2, proofGeneration: 2, allowed: false },
    { database: true, kind: true, generation: 2, launchGeneration: 1, proofGeneration: 2, allowed: false },
    { database: true, kind: true, generation: 2, launchGeneration: 2, proofGeneration: 1, allowed: false },
    { database: true, kind: true, generation: 2, launchGeneration: 2, proofGeneration: undefined, allowed: false },
  ])('requires a current database course binding and matching fresh Moodle entry proof (%j)', async test => {
    const binding = { deploymentId: registration.deploymentId,contextId: '42',resourceLinkId: 'entry',courseId: 1,
      generation: test.generation,...(test.kind ? {kind:'course' as const} : {}) };
    const reg = { ...registration,id: test.database ? 'db:school' : 'static',issuer: 'https://moodle.example',
      authorizationUrl: 'https://moodle.example/auth',jwksUrl: 'https://moodle.example/keys',frameOrigins: ['https://moodle.example'],resources: [binding] };
    const spy = vi.spyOn(globalThis,'fetch').mockImplementation(mockService({ contextId: '42',resourceLinkId: 'entry',
      permissions: {viewQa:true},resources: [],...(test.proofGeneration ? {courseEntry:{generation:test.proofGeneration}} : {}) }));
    try {
      const result = courseAccessContext(reg,{...binding,resourceGeneration:test.launchGeneration,serviceSubject:'student'},env as Bindings);
      if(test.allowed) expect(await result).toMatchObject({videos:[],permissions:{viewQa:true,manageContent:false}});
      else await expect(result).rejects.toThrow('Moodle access denied');
    } finally {spy.mockRestore();}
  });
  it.each([
    { manageContent: true, moduleGrant: true, database: true, generation: 1, bindingGeneration: 1, allowed: true },
    { manageContent: false, moduleGrant: true, database: true, generation: 1, bindingGeneration: 1, allowed: false },
    { manageContent: true, moduleGrant: false, database: true, generation: 1, bindingGeneration: 1, allowed: false },
    { manageContent: true, moduleGrant: true, database: false, generation: 1, bindingGeneration: 1, allowed: false },
    { manageContent: true, moduleGrant: true, database: true, generation: 2, bindingGeneration: 1, allowed: false },
  ])("isolates processing-only management grants from learner access (%j)", async test => {
    const binding = { deploymentId: registration.deploymentId, contextId: "course", resourceLinkId: "launch", courseId: 1,
      videoId: 10, generation: test.bindingGeneration, learningAvailable: false };
    const reg = { ...registration, id: test.database ? "db:school" : "configured", issuer: "https://moodle.example",
      authorizationUrl: "https://moodle.example/auth", jwksUrl: "https://moodle.example/keys", frameOrigins: ["https://moodle.example"], resources: [binding] };
    const result = { contextId: "course", resourceLinkId: "launch", permissions: { manageContent: test.manageContent },
      resources: [{ externalId: "source", resourceLinkId: "launch", lesson: "lesson", title: "Processing", learning: false,
        generation: test.generation, ...(test.moduleGrant ? { management: { generation: test.generation } } : {}) }] };
    const spy = vi.spyOn(globalThis,"fetch").mockImplementation(mockService(result));
    try {
      const access = courseAccessContext(reg,{...binding, serviceSubject:"teacher"},env as Bindings);
      if (test.allowed) expect(await access).toMatchObject({videos:[],managementVideos:[{videoId:10,management:{generation:1}}]});
      else await expect(access).rejects.toThrow("Moodle access denied");
    } finally { spy.mockRestore(); }
  });
  it("rejects a stale completed source and rechecks a revoked management capability", async () => {
    const binding = { deploymentId: registration.deploymentId, contextId:"course", resourceLinkId:"launch", courseId:1,
      videoId:10, generation:1, learningAvailable:true };
    const reg = {...registration,id:"db:school",issuer:"https://moodle.example",authorizationUrl:"https://moodle.example/auth",
      jwksUrl:"https://moodle.example/keys",frameOrigins:["https://moodle.example"],resources:[binding]};
    let generation=1, permitted=true;
    const spy=vi.spyOn(globalThis,"fetch").mockImplementation((input,init)=>mockService({contextId:"course",resourceLinkId:"launch",
      permissions:{manageContent:permitted},resources:[{externalId:"source",resourceLinkId:"launch",lesson:"lesson",title:"Ready",
        generation, management:{generation}}]})(input,init));
    const get=()=>courseAccessContext(reg,{...binding,serviceSubject:"teacher"},env as Bindings);
    try {
      expect((await get())?.managementVideos).toHaveLength(1);
      permitted=false;
      expect(await get()).toMatchObject({videos:[{videoId:10}],permissions:{manageContent:false}});
      expect((await get())?.managementVideos).toBeUndefined();
      generation=2;
      await expect(get()).rejects.toThrow("Moodle access denied");
    } finally {spy.mockRestore();}
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
