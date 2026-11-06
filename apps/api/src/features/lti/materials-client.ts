import { z } from "zod";
import { resourceManifestSchema } from "../lms/resource";
import { toolClientAssertion, type ToolKeyEnvironment } from "./tool-keys";
import { coursePermissionsSchema } from "./course-permissions";

export const MATERIALS_SCOPE = "https://videoq.org/spec/lti-materials/v1";
export const materialManagementSchema = z.object({ generation: z.number().int().positive().safe() }).strict();
export const courseEntryAccessSchema = z.object({ generation: z.number().int().positive().safe() }).strict();
const httpsEndpoint = z.url().max(2048).refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash;
});
export const materialsServiceSchema = z.object({ tokenEndpoint: httpsEndpoint, endpoint: httpsEndpoint }).strict();
export type MaterialsService = z.infer<typeof materialsServiceSchema>;
const identity = z.string().min(1).max(255);
export const materialsManifestSchema = z.object({ contextId: identity,
  // A complete snapshot is explicit; missing entries are never interpreted as tombstones.
  complete: z.literal(true), resources: z.array(z.object({ externalId: identity,
    manifest: resourceManifestSchema }).strict()).max(1001),
}).strict().superRefine((snapshot, ctx) => {
  const ids = new Set<string>();
  let entries = 0, videos = 0;
  for (const resource of snapshot.resources) {
    if (resource.manifest.kind === 'course') entries++; else videos++;
    if (resource.manifest.contextId !== snapshot.contextId || ids.has(resource.externalId)) {
      ctx.addIssue({ code: "custom", message: "Duplicate or cross-context material" });
    }
    ids.add(resource.externalId);
  }
  if (entries > 1 || videos > 1000) ctx.addIssue({ code: 'custom', message: 'Too many course entries or materials' });
});
export const exportStatusSchema = z.object({ jobId: z.string().regex(/^[a-f0-9-]{32,64}$/),
  generation: z.number().int().positive().safe(), status: z.enum(["queued", "uploading", "uploaded", "failed", "stale"]),
  bytes: z.number().int().nonnegative().safe().optional(),
}).strict();

/** Bound the bytes while reading, before decoding or parsing an external response. */
export async function readServiceJson(response: Response, maxBytes = 1024 * 1024) {
  if (!response.ok || !response.body) throw new Error("LTI materials service unavailable");
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const parts: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("LTI materials response too large");
      parts.push(value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Small control-plane requests only. URLs come from an approved registration. */
export class MaterialsClient {
  private credential?: { value: string; until: number };
  constructor(private env: ToolKeyEnvironment,
    private registration: { clientId: string; deploymentId: string; materialsService: MaterialsService },
    private request: typeof fetch = fetch) {
    materialsServiceSchema.parse(registration.materialsService);
  }
  private async json(response: Response, maxBytes = 1024 * 1024) {
    return readServiceJson(response, maxBytes);
  }
  private async token() {
    if (this.credential && this.credential.until > Date.now()) return this.credential.value;
    const { tokenEndpoint } = this.registration.materialsService;
    const assertion = await toolClientAssertion(this.env, this.registration.clientId, this.registration.deploymentId, tokenEndpoint);
    const response = await this.request(tokenEndpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion, scope: MATERIALS_SCOPE }) });
    const token = z.object({ access_token: z.string().min(1).max(8192), token_type: z.string(),
      expires_in: z.number().int().positive().max(3600), scope: z.string() }).parse(await this.json(response, 16384));
    if (token.token_type.toLowerCase() !== "bearer" || token.scope !== MATERIALS_SCOPE) throw new Error("Invalid LTI service token scope");
    this.credential = { value: token.access_token, until: Date.now() + Math.max(0, Math.min(token.expires_in - 5, 30)) * 1000 };
    return token.access_token;
  }
  private async call(action: string, body: Record<string, unknown>) {
    const token = await this.token();
    const response = await this.request(this.registration.materialsService.endpoint, { method: "POST", redirect: "error",
      signal: AbortSignal.timeout(10000), headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
      // Older Moodle versions ignore unknown request fields and keep their
      // video-only response. New Moodle sends entries only to opted-in callers.
      body: JSON.stringify({ action, ...body, includeCourseEntries: true, includeUserVisibility: true, includeReports: true,
        includeYoutubeSources: true }) });
    return this.json(response);
  }
  async courses() {
    return z.object({ contextIds: z.array(identity).max(1000) }).strict().parse(await this.call("courses", {})).contextIds;
  }
  async acknowledge(contextId: string, externalId: string, generation: number, status: string, error: string | null) {
    const receipt = z.object({ acknowledged: z.literal(true) }).strict().parse(await this.call("ack", { contextId, externalId, generation, status, error }));
    return receipt.acknowledged;
  }
  async manifest(contextId: string) {
    const snapshot = materialsManifestSchema.parse(await this.call("manifest", { contextId }));
    if (snapshot.contextId !== contextId) throw new Error("Wrong LTI materials context");
    return snapshot;
  }
  async access(contextId: string, resourceLinkId: string, subject: string) {
    const access = z.object({ contextId: identity, resourceLinkId: identity,
      permissions: coursePermissionsSchema.optional(),
      courseEntry: courseEntryAccessSchema.optional(),
      resources: z.array(z.object({ externalId: identity, resourceLinkId: identity,
        lesson: z.string().regex(/^[a-z0-9_-]{1,64}$/), title: z.string().max(500),
        generation: z.number().int().positive().safe().optional(),
        learning: z.boolean().optional(), management: materialManagementSchema.optional() }).strict()).max(1000),
    }).strict().parse(await this.call("access", { contextId, resourceLinkId, subject, includePermissions: true, includeContentManagement: true }));
    if (access.contextId !== contextId || access.resourceLinkId !== resourceLinkId) throw new Error("Wrong LTI access context");
    return access;
  }
  async startExport(contextId: string, externalId: string, generation: number, uploadUrl: string, idempotencyKey: string) {
    const status = exportStatusSchema.parse(await this.call("export", { contextId, externalId, generation, uploadUrl, idempotencyKey }));
    if (status.generation !== generation) throw new Error("Stale LTI export receipt");
    return status;
  }
  async exportStatus(contextId: string, jobId: string, generation: number) {
    const status = exportStatusSchema.parse(await this.call("status", { contextId, jobId }));
    if (status.jobId !== jobId || status.generation !== generation) throw new Error("Wrong LTI export receipt");
    return status;
  }
}
