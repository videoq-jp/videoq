import { materialsServiceSchema } from "./materials-client";
import { z } from "zod";
import type { Bindings } from "../../types/bindings";

const httpsUrl = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash;
}, "An HTTPS URL without credentials or fragment is required");
const origin = httpsUrl.refine(value => new URL(value).origin === value, "An exact HTTPS origin is required");
const resource = z.object({
  deploymentId: z.string().min(1),
  contextId: z.string().min(1),
  resourceLinkId: z.string().min(1),
  courseId: z.number().int().positive().safe(),
  videoId: z.number().int().positive().safe().optional(),
  generation: z.number().int().positive().safe().optional(),
}).strict();
const registration = z.object({
  id: z.string().min(1),
  issuer: httpsUrl,
  clientId: z.string().min(1),
  authorizationUrl: httpsUrl,
  jwksUrl: httpsUrl,
  courseAccess: z.literal("moodle").optional(),
  materialsService: materialsServiceSchema.optional(),
  deploymentId: z.string().min(1).optional(),
  frameOrigins: z.array(origin).min(1).max(20),
  resources: z.array(resource).max(1000),
}).strict().refine(value => value.materialsService ? Boolean(value.deploymentId) : value.resources.length > 0, "Resources or a materials service with a deployment are required");
const schema = z.object({
  toolOrigin: origin,
  databaseRegistrations: z.boolean().optional(),
  registrations: z.array(registration).max(100),
}).strict().superRefine((config, ctx) => {
  if (!config.databaseRegistrations && !config.registrations.length) ctx.addIssue({ code: "custom", message: "At least one registration is required" });
  const ids = new Set<string>();
  const clients = new Set<string>();
  for (const reg of config.registrations) {
    const client = JSON.stringify([reg.issuer, reg.clientId]);
    if (ids.has(reg.id) || clients.has(client)) ctx.addIssue({ code: "custom", message: "Duplicate registration" });
    ids.add(reg.id); clients.add(client);
    const resources = new Set<string>();
    for (const item of reg.resources) {
      const key = JSON.stringify([item.deploymentId, item.contextId, item.resourceLinkId]);
      if (resources.has(key)) ctx.addIssue({ code: "custom", message: "Duplicate resource binding" });
      resources.add(key);
    }
  }
});
export type LtiRegistration = z.infer<typeof registration>;
export type LtiConfig = z.infer<typeof schema>;

export function ltiConfig(env: Pick<Bindings, "LTI_CONFIG">): LtiConfig | null {
  if (!env.LTI_CONFIG?.trim()) return null;
  try { return schema.parse(JSON.parse(env.LTI_CONFIG)); }
  catch { throw new Error("Invalid LTI_CONFIG; check the administrator-managed registration configuration"); }
}
