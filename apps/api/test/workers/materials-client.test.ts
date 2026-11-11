import { expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair } from "jose";
import { MaterialsClient } from "../../src/features/lms/connector-client";

vi.mock("../../src/db/pool", () => ({ withDb: () => { throw new Error("Unexpected database access"); } }));

it("authenticates and reads Moodle courses and materials using native Workers fetch", async () => {
  const pair = await generateKeyPair("RS256", { extractable: true, modulusLength: 2048 });
  const env = { LTI_TOOL_KEYS: JSON.stringify({ current: await exportJWK(pair.privateKey), previous: [] }) };
  // Do not inject or stub fetch: workerd must check the actual receiver.
  const client = new MaterialsClient(env, { clientId: "worker-client", deploymentId: "7",
    materialsService: { tokenEndpoint: "https://materials.example/token", endpoint: "https://materials.example/materials" } });
  expect(await client.courses()).toEqual(["course-1"]);
  const snapshot = await client.manifest("course-1");
  expect(snapshot.resources[0]).toMatchObject({ externalId: "video-1", manifest: { title: "Lesson", enabled: true } });
});

it.each(["token", "materials"])("rejects %s redirects without following them in Workers", async endpoint => {
  const pair = await generateKeyPair("RS256", { extractable: true, modulusLength: 2048 });
  const env = { LTI_TOOL_KEYS: JSON.stringify({ current: await exportJWK(pair.privateKey), previous: [] }) };
  const client = new MaterialsClient(env, { clientId: "worker-client", deploymentId: "7", materialsService: {
    tokenEndpoint: "https://materials.example/" + (endpoint === "token" ? "token-redirect" : "token"),
    endpoint: "https://materials.example/" + (endpoint === "materials" ? "materials-redirect" : "materials"),
  } });
  await expect(client.courses()).rejects.toThrow("LTI materials service unavailable");
});
