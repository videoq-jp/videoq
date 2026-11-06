import { describe, expect, it } from "vitest";
import { newSyncToken, provisionInstallationSchema, syncTokenHash } from "../src/features/lms/installation";
import { authenticateLmsInstallation } from "../src/repositories/lms-installation-repository";
import type { Bindings } from "../src/types/bindings";

const installation = {
  id: "moodle-1", ownerUserId: "school-1", name: "学校のMoodle",
  issuer: "https://moodle.example/campus", clientId: "client-1", deploymentId: "deployment-1",
  authorizationUrl: "https://moodle.example/campus/mod/lti/auth.php",
  jwksUrl: "https://moodle.example/campus/mod/lti/certs.php",
};

describe("Moodle installation provisioning boundary", () => {
  it("accepts Moodle hosted under a path", () => {
    expect(provisionInstallationSchema.parse(installation)).toEqual(installation);
  });
  it.each(["http://moodle.example", "https://user:pass@moodle.example", "https://moodle.example/#fragment", "https://moodle.example/?secret=value"])("refuses unsafe issuer %s", issuer => {
    expect(provisionInstallationSchema.safeParse({ ...installation, issuer }).success).toBe(false);
  });
  it.each(["authorizationUrl", "jwksUrl"])("refuses an unrelated %s", key => {
    expect(provisionInstallationSchema.safeParse({ ...installation, [key]: "https://other.example/endpoint" }).success).toBe(false);
  });
  it("does not accept a caller-selected quota or credential", () => {
    expect(provisionInstallationSchema.safeParse({ ...installation, aiAnswersLimit: 9999 }).success).toBe(false);
    expect(provisionInstallationSchema.safeParse({ ...installation, syncTokenHash: "a".repeat(64) }).success).toBe(false);
  });
  it("issues independent 256-bit credentials and hashes them before storage", async () => {
    const first = newSyncToken(), second = newSyncToken();
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
    expect(await syncTokenHash(first)).not.toBe(first);
    expect(await syncTokenHash("a".repeat(64))).toBe("ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb");
  });
  it.each(["", "a".repeat(63), "A".repeat(64), "Bearer " + "a".repeat(64), "a".repeat(10000)])("refuses malformed tokens before accessing the database", async token => {
    expect(await authenticateLmsInstallation({} as Bindings, token)).toBeNull();
  });
});
