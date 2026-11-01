import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { isS3Storage } from "../../integrations/media";
import { requireAuth, sessionMethod } from "../../middleware/auth";
import type { AppEnv } from "../../types/bindings";
import * as videoService from "./service";

/** Multipart upload is retained as raw HTTP; JSON video operations use tRPC. */
export const videoRoutes = new Hono<AppEnv>();

videoRoutes.post(
  "/",
  requireAuth(sessionMethod),
  async (c) => {
    // Production uploads go directly to R2. Reject before parseBody() so a
    // deprecated multipart request is never buffered in the Worker isolate.
    if (isS3Storage(c.env)) {
      return c.json(videoService.multipartUnavailableBody(), 400);
    }
    const form = await c.req.parseBody();
    const result = await videoService.createVideoFromMultipart(
      c.env,
      c.var.userId!,
      form,
    );
    if (!result.ok) {
      return c.json(result.body, result.status as ContentfulStatusCode);
    }
    return c.json(result.video, 201);
  },
);
