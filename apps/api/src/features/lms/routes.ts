import { moodlePairingRoutes } from "./pairing-routes";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { MAX_SINGLE_UPLOAD_BYTES } from "@videoq/trpc/video-upload";
import type { AppEnv } from "../../types/bindings";
import { withDb } from "../../db/pool";
import { lmsResources, videos } from "../../db/schema";
import { authenticateLmsInstallation } from "../../repositories/lms-installation-repository";
import { getLmsResource, lockLmsGrant, syncLmsResource } from "../../repositories/lms-resource-repository";
import { isS3Storage, presignR2Put, putMediaObject } from "../../integrations/media";
import { confirmVideoUpload } from "../videos/service";
import { ltiConfig } from "../lti/config";
import { LmsSyncError, resourceManifestSchema } from "./resource";
import { armMaintenance } from "../../lib/task-scheduler";
import { ABANDONED_UPLOAD_MS } from "../../lib/upload-reconcile";
import { lmsUploadStream } from "./upload";
import { moodlePrivacyRoutes } from './privacy-routes';
import { moodleNativeRoutes } from './native-routes';
import { features } from '../../lib/deployment';

export const lmsRoutes = new Hono<AppEnv>();
lmsRoutes.route("/pairing", moodlePairingRoutes);
lmsRoutes.route('/privacy',moodlePrivacyRoutes);
lmsRoutes.route('/native',moodleNativeRoutes);
const generationSchema = z.object({ generation: z.number().int().positive().safe() }).strict();

lmsRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (!ltiConfig(c.env)?.databaseRegistrations) return c.json({ error: "LMS_SYNC_DISABLED" }, 404);
  await next();
});
lmsRoutes.onError((error, c) => {
  if (error instanceof LmsSyncError) return c.json({ error: error.code }, error.status);
  console.error(JSON.stringify({ event: "lms_sync_failed", type: error.name }));
  return c.json({ error: "LMS_SYNC_FAILED" }, 500);
});

async function installation(c: Context<AppEnv>) {
  const token = c.req.header("Authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  const grant = token ? await authenticateLmsInstallation(c.env, token) : null;
  if (!grant) throw new LmsSyncError(401, "INVALID_INSTALLATION_CREDENTIAL");
  return grant;
}

async function resourceResponse(c: Context<AppEnv>, grant: { id: string; ownerUserId: string }) {
  const externalId = c.req.param("externalId")!;
  const data = await getLmsResource(c.env, grant, externalId);
  if (!data) throw new LmsSyncError(404, "RESOURCE_NOT_FOUND");
  const { resource, video } = data;
  const base = ltiConfig(c.env)!.toolOrigin + "/api/lms/resources/" + encodeURIComponent(externalId);
  let uploadUrl: string | null = null;
  if (resource.kind === 'video' && resource.enabled && video?.status === "uploading") {
    uploadUrl = isS3Storage(c.env)
      ? await presignR2Put(c.env, video.file, resource.contentType!, resource.fileSize!)
      : base + "/content?generation=" + resource.generation;
  }
  return {
    generation: resource.generation,
    status: !resource.enabled ? "disabled" : resource.syncError ? "blocked" : resource.kind === 'course' ? 'completed' : video?.status ?? "awaiting_upload",
    error: resource.syncError,
    upload: uploadUrl ? { url: uploadUrl, method: "PUT", direct: isS3Storage(c.env), contentType: resource.contentType, size: resource.fileSize } : null,
    confirmUrl: base + "/confirm",
  };
}

lmsRoutes.get("/connection", async c => {
  const grant = await installation(c);
  return c.json({ issuer: grant.issuer, clientId: grant.clientId, deploymentId: grant.deploymentId,
    toolOrigin: ltiConfig(c.env)!.toolOrigin, maxVideoBytes: MAX_SINGLE_UPLOAD_BYTES, courseEntries: true, userVisibility: true,
    youtubeSourceProtocol: true, youtubeSources: features(c.env).youtube });
});

lmsRoutes.get("/resources/:externalId", async c => {
  const grant = await installation(c);
  return c.json(await resourceResponse(c, grant));
});

lmsRoutes.put("/resources/:externalId", bodyLimit({ maxSize: 32 * 1024 }), async c => {
  const grant = await installation(c);
  const input = resourceManifestSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success || !(input.data.kind === 'course'
    ? /^[1-9][0-9]{0,17}$/.test(input.data.contextId) && c.req.param('externalId') === 'course_' + input.data.contextId
    : /^[1-9][0-9]{0,17}$/.test(c.req.param('externalId')))) throw new LmsSyncError(400, "INVALID_MANIFEST");
  await syncLmsResource(c.env, grant, c.req.param("externalId"), input.data);
  if (input.data.kind !== 'course') {
    await armMaintenance(c.env, Date.now());
    if (!input.data.kind) await armMaintenance(c.env, Date.now() + ABANDONED_UPLOAD_MS);
  }
  return c.json(await resourceResponse(c, grant));
});

lmsRoutes.put("/resources/:externalId/content", async c => {
  const grant = await installation(c);
  if (isS3Storage(c.env)) throw new LmsSyncError(400, "USE_DIRECT_UPLOAD");
  const generation = Number(c.req.query("generation"));
  const data = await getLmsResource(c.env, grant, c.req.param("externalId"));
  if (!data?.video || data.resource.kind !== 'video' || !data.resource.enabled || data.resource.generation !== generation) throw new LmsSyncError(409, "STALE_GENERATION");
  const expected = data.resource.fileSize!;
  if (c.req.header("Content-Length") !== String(expected) || c.req.header("Content-Type") !== data.resource.contentType) throw new LmsSyncError(400, "INVALID_UPLOAD_HEADERS");
  if (!c.req.raw.body) throw new LmsSyncError(400, "EMPTY_UPLOAD");
  // Fetch request bodies contain byte chunks; the Workers declaration uses
  // ReadableStream<any> rather than expressing that platform guarantee.
  const stream = lmsUploadStream(c.req.raw.body as ReadableStream<Uint8Array>, expected);
  await withDb(c.env, db => db.transaction(async tx => {
    await lockLmsGrant(tx, grant);
    const [resource] = await tx.select().from(lmsResources).where(eq(lmsResources.id, data.resource.id)).for("update");
    const [video] = await tx.select().from(videos).where(eq(videos.id, data.video!.id)).for("update");
    if (!resource?.enabled || resource.generation !== generation || resource.videoId !== video?.id || video.status !== "uploading") throw new LmsSyncError(409, "STALE_GENERATION");
    await putMediaObject(c.env, video.file, stream, resource.contentType!);
  }));
  return c.json({ uploaded: true });
});

lmsRoutes.post("/resources/:externalId/confirm", bodyLimit({ maxSize: 1024 }), async c => {
  const grant = await installation(c);
  const input = generationSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) throw new LmsSyncError(400, "INVALID_GENERATION");
  const data = await getLmsResource(c.env, grant, c.req.param("externalId"));
  if (!data?.resource.enabled || data.resource.kind !== 'video' || data.resource.generation !== input.data.generation || !data.video || !data.ownerUserId) throw new LmsSyncError(409, "STALE_GENERATION");
  const result = await confirmVideoUpload(c.env, data.video.id, data.ownerUserId);
  if (!("video" in result)) throw new LmsSyncError(409, "UPLOAD_NOT_CONFIRMED");
  return c.json(await resourceResponse(c, grant));
});
