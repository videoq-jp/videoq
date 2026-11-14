export type PersistenceBackend = "d1" | "postgres";
export type PersistenceSettings = {
  DEPLOYMENT_EDITION?: "cloud" | "onprem";
  RUNTIME?: "node";
  PERSISTENCE_BACKEND?: PersistenceBackend;
  MIGRATION_ALLOW_CLOUD_POSTGRES?: "true";
};

/** Unspecified edition retains the legacy configuration until the explicit cutover. */
export function persistenceBackend(config: PersistenceSettings): PersistenceBackend {
  if (config.DEPLOYMENT_EDITION !== undefined && config.DEPLOYMENT_EDITION !== "cloud" && config.DEPLOYMENT_EDITION !== "onprem") {
    throw new Error("Invalid deployment edition");
  }
  const edition = config.DEPLOYMENT_EDITION ?? (config.RUNTIME === "node" ? "onprem" : undefined);
  const backend = config.PERSISTENCE_BACKEND ?? (edition === "cloud" ? "d1" : "postgres");
  if (backend !== "d1" && backend !== "postgres") throw new Error("Invalid persistence backend");
  if (edition === "onprem" && backend !== "postgres") throw new Error("On-premises requires PostgreSQL");
  if (edition === "cloud" && backend === "postgres" && config.MIGRATION_ALLOW_CLOUD_POSTGRES !== "true") {
    throw new Error("Cloud PostgreSQL requires the explicit migration rollback flag");
  }
  return backend;
}
