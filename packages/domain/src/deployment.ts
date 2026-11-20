export type DeploymentEdition = "cloud" | "onprem";

export function deploymentEdition(value?: string): DeploymentEdition {
  if (!value || value === "cloud") return "cloud";
  if (value === "onprem") return "onprem";
  throw new Error("DEPLOYMENT_EDITION must be cloud or onprem");
}

export function deploymentFeatures(edition: DeploymentEdition) {
  const cloud = edition === "cloud";
  return { billing: cloud, marketing: cloud, publicSignup: cloud,
    googleLogin: cloud, youtube: cloud, emailDelivery: cloud } as const;
}
