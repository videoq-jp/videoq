import { expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from "jose";
import { toolClientAssertion, toolJwks } from "../../src/features/lti/tool-keys";
import { decryptServerSecret, encryptServerSecret } from "../../src/lib/secret-encryption";
import type { Bindings } from "../../src/types/bindings";

// Exercise native crypto here; real PostgreSQL initialization/reuse is covered
// by lms-sync.integration.test.ts. An explicit ring must never open a DB client.
vi.mock("../../src/db/pool", () => ({ withDb: () => { throw new Error("Unexpected signing-key database access"); } }));

it("encrypts and recovers a generated signing identity with native Workers crypto", async () => {
  const env = { USER_SECRET_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(13))).replace(/=+$/, "") } as Bindings;
  const generated = await generateKeyPair("RS256", { extractable: true, modulusLength: 2048 });
  const ring = JSON.stringify({ current: await exportJWK(generated.privateKey), previous: [] });
  const encrypted = await encryptServerSecret(env, ring, "lti-fixture");
  expect(encrypted).not.toContain(ring);
  await expect(decryptServerSecret(env, encrypted, "other-purpose")).rejects.toThrow("could not be decrypted");
  const restored = { LTI_TOOL_KEYS: await decryptServerSecret(env, encrypted, "lti-fixture") };
  const published = await toolJwks(restored);
  expect(Object.keys(published.keys[0]).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
  const assertion = await toolClientAssertion(restored, "client", "7", "https://moodle.example/token");
  const verified = await jwtVerify(assertion, createLocalJWKSet(published), { issuer: "client", audience: "https://moodle.example/token", algorithms: ["RS256"] });
  expect(verified.payload.sub).toBe("client");
});
