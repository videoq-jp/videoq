import { describe, expect, it } from "vitest";
import { withClient } from "../../src/db/pool";
import { persistenceBackend } from "../../src/persistence/backend";
import { createUserSecretsRepository } from "../../src/persistence/factory";
import type { Bindings } from "../../src/types/bindings";

describe("persistence configuration", () => {
  it("selects D1 for cloud and PostgreSQL for on-premises", () => {
    expect(persistenceBackend({ DEPLOYMENT_EDITION: "cloud" })).toBe("d1");
    expect(persistenceBackend({ DEPLOYMENT_EDITION: "onprem" })).toBe("postgres");
    expect(persistenceBackend({ RUNTIME: "node" })).toBe("postgres");
  });
  it("rejects conflicting settings and requires an explicit cloud rollback", () => {
    expect(() => persistenceBackend({ DEPLOYMENT_EDITION: "onprem", PERSISTENCE_BACKEND: "d1" })).toThrow();
    expect(() => persistenceBackend({ DEPLOYMENT_EDITION: "cloud", PERSISTENCE_BACKEND: "postgres" })).toThrow();
    expect(persistenceBackend({ DEPLOYMENT_EDITION: "cloud", PERSISTENCE_BACKEND: "postgres", MIGRATION_ALLOW_CLOUD_POSTGRES: "true" })).toBe("postgres");
  });
  it.each(["", "clodu", "on-prem", "CLOUD", null])("rejects an invalid edition before repository creation: %s", async edition => {
    const settings = { DEPLOYMENT_EDITION: edition, DATABASE_URL: "postgresql://unused" } as unknown as Bindings;
    expect(() => persistenceBackend(settings)).toThrow("Invalid deployment edition");
    await expect(createUserSecretsRepository(settings)).rejects.toThrow("Invalid deployment edition");
  });
  it("never uses a PostgreSQL URL when the required D1 binding is absent", async () => {
    await expect(createUserSecretsRepository({
      DEPLOYMENT_EDITION: "cloud", DATABASE_URL: "postgresql://unused",
    } as Bindings)).rejects.toThrow("D1 DB binding is required");
  });
  it("fails closed for operations that have not yet been ported to D1", async () => {
    await expect(withClient({ PERSISTENCE_BACKEND: "d1", DATABASE_URL: "postgresql://unused" } as Bindings,
      () => Promise.resolve("unexpected"))).rejects.toThrow("cannot run against D1");
  });
});
