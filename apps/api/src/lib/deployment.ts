import { deploymentEdition, deploymentFeatures } from "@videoq/domain/deployment";
import type { Bindings } from "../types/bindings";
import { apiNotFound } from "../shared/errors";

export function features(env: Pick<Bindings, "DEPLOYMENT_EDITION" | "RUNTIME">) {
  return deploymentFeatures(deploymentEdition(env.DEPLOYMENT_EDITION || (env.RUNTIME === "node" ? "onprem" : "cloud")));
}

export function requireFeature(env: Bindings, feature: keyof ReturnType<typeof features>) {
  if (!features(env)[feature]) throw apiNotFound("This feature is unavailable in this deployment.", "FEATURE_DISABLED");
}
