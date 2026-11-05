import { beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from "jose";
import { CLAIM, verifyLaunch } from "../src/features/lti/protocol";
import { ltiConfig, type LtiRegistration } from "../src/features/lti/config";
import { launchLocale, resolveLtiLocale } from "../src/features/lti/locale";
import { questionView } from "../src/features/lti/view";
import { scriptJson } from "../src/features/lti/view";

const reg: LtiRegistration = {
  id: "moodle", issuer: "https://lms.example", clientId: "videoq",
  authorizationUrl: "https://lms.example/auth", jwksUrl: "https://lms.example/keys",
  frameOrigins: ["https://lms.example"],
  resources: [{ deploymentId: "dep", contextId: "ctx", resourceLinkId: "res", courseId: 12 }],
};
const login = { registrationId: "moodle", nonce: "nonce", browserHash: "hash", target: "https://api.example/api/lti/launch" };
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
let keys: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  pair = await generateKeyPair("RS256");
  keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: "test", alg: "RS256" }] });
});
async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({
    iss: reg.issuer, aud: reg.clientId, sub: "learner-1", nonce: "nonce",
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60,
    [CLAIM + "version"]: "1.3.0", [CLAIM + "message_type"]: "LtiResourceLinkRequest",
    [CLAIM + "deployment_id"]: "dep", [CLAIM + "target_link_uri"]: login.target,
    [CLAIM + "context"]: { id: "ctx" }, [CLAIM + "resource_link"]: { id: "res" },
    [CLAIM + "roles"]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner"],
    ...overrides,
  }).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(pair.privateKey);
}
describe("LTI launch verification", () => {
  it("resolves only an exact administrator-configured resource", async () => {
    const result = await verifyLaunch(await token(), reg, login, keys);
    expect(result).toMatchObject({ subject: "learner-1", courseId: 12, contextId: "ctx" });
  });
  it("requires a Moodle-signed access claim for course-scoped Moodle registrations", async () => {
    const scoped = { ...reg, courseAccess: "moodle" as const };
    await expect(verifyLaunch(await token(), scoped, login, keys)).rejects.toThrow();
    const proof = "aa." + "b".repeat(64);
    const result = await verifyLaunch(await token({ [CLAIM + "custom"]: { videoq_access: proof } }), scoped, login, keys);
    expect(result.accessProof).toEqual({ token: proof, subject: "learner-1" });
  });
  it.each([
    { iss: "https://attacker.example" }, { aud: "another-client" }, { nonce: "another-login" },
    { exp: 1 }, { iat: 1 }, { azp: "another-client" }, { aud: ["videoq", "other"] },
    { sub: "" }, { sub: { id: "learner" } },
    { [CLAIM + "version"]: "1.1.0" }, { [CLAIM + "message_type"]: "LtiDeepLinkingRequest" },
    { [CLAIM + "deployment_id"]: "other" }, { [CLAIM + "context"]: { id: "other" } },
    { [CLAIM + "resource_link"]: { id: "other" } }, { [CLAIM + "target_link_uri"]: "https://attacker.example" },
    { [CLAIM + "roles"]: [] }, { [CLAIM + "roles"]: ["Learner"] },
  ])("rejects invalid or unbound claims %j", async overrides => {
    await expect(verifyLaunch(await token(overrides), reg, login, keys)).rejects.toThrow();
  });
  it.each([["en-US", "en"], ["ja_JP", "ja"]])("retains the LMS locale %s in the verified grant", async (locale, expected) => {
    const result = await verifyLaunch(await token({ [CLAIM + "launch_presentation"]: { locale } }), reg, { ...login, locale: "ja" }, keys);
    expect(result.locale).toBe(expected);
  });
  it("rejects a different deployment from the initiation hint", async () => {
    await expect(verifyLaunch(await token(), reg, { ...login, deploymentHint: "other" }, keys)).rejects.toThrow();
  });
  it("rejects forged signatures", async () => {
    const other = await generateKeyPair("RS256");
    const wrongKeys = createLocalJWKSet({ keys: [{ ...await exportJWK(other.publicKey), kid: "test" }] });
    await expect(verifyLaunch(await token(), reg, login, wrongKeys)).rejects.toThrow();
  });
});
describe("LTI administrator configuration", () => {
  it("is disabled by default", () => expect(ltiConfig({})).toBeNull());
  it("accepts a registration", () => expect(ltiConfig({ LTI_CONFIG: JSON.stringify({ toolOrigin: "https://api.example", registrations: [reg] }) })).not.toBeNull());
  it.each([
    { ...reg, frameOrigins: ["*"] }, { ...reg, jwksUrl: "http://localhost/keys" },
    { ...reg, resources: [...reg.resources, ...reg.resources] },
  ])("fails closed on unsafe or ambiguous configuration", registration => {
    expect(() => ltiConfig({ LTI_CONFIG: JSON.stringify({ toolOrigin: "https://api.example", registrations: [registration] }) })).toThrow();
  });
  it("escapes HTML and JS delimiters in launch bootstrap data", () => {
    const encoded = scriptJson('</script><script>alert(1)</script>\u2028');
    expect(encoded).not.toContain("<");
    expect(JSON.parse(encoded)).toBe('</script><script>alert(1)</script>\u2028');
  });
});

describe("LTI language selection", () => {
  it("uses supported LMS language before browser preferences", () => {
    expect(launchLocale({ [CLAIM + "launch_presentation"]: { locale: "en-GB" } }, "ja")).toBe("en");
    expect(launchLocale({ [CLAIM + "launch_presentation"]: { locale: "ja" } }, "en")).toBe("ja");
    expect(launchLocale({}, "ja")).toBe("ja");
    expect(resolveLtiLocale("fr,ja-JP;q=0.9,en;q=0.8")).toBe("ja");
    expect(resolveLtiLocale("ja;q=0,en;q=1")).toBe("en");
    expect(resolveLtiLocale({ locale: "ja" })).toBe("en");
  });
  it("renders English labels and runtime errors without Japanese UI copy", () => {
    const html = questionView("nonce", "state", "token", "en");
    expect(html).toContain('lang="en"');
    expect(html).toContain("Ask about this course");
    expect(html).toContain("Your session has expired.");
    expect(html).not.toMatch(/[ぁ-んァ-ヶ一-龯]/);
  });
});
