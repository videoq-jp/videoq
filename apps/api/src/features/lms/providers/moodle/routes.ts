import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../../../../types/bindings";
import { requireAuth, sessionMethod } from "../../../../middleware/auth";
import { clientIp, enforceThrottles, throttledResponse } from "../../../../lib/rate-limit";
import { ltiConfig, ltiMaterialsEnabled } from "../../../lti/config";
import { LmsSyncError } from "../../resource";
import { exchangeMoodlePairing, issueMoodlePairing, pairingExchangeSchema, pairingRequestSchema } from "./pairing";
import { moodleManagementRequest } from '@videoq/trpc/moodle-management';
import { managementContext } from './management-context';
import { features } from '../../../../lib/deployment';

export const moodlePairingRoutes = new Hono<AppEnv>();
moodlePairingRoutes.use("*", bodyLimit({ maxSize: 8192 }));
moodlePairingRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (!ltiConfig(c.env)?.databaseRegistrations) return c.json({ error: "LMS_SYNC_DISABLED" }, 404);
  await next();
});
moodlePairingRoutes.onError((error, c) => {
  if (error instanceof LmsSyncError) return c.json({ error: error.code }, error.status);
  // Database errors can include credential parameters: never return or log them.
  console.error(JSON.stringify({ event: "moodle_pairing_failed", type: error.name }));
  return c.json({ error: "PAIRING_FAILED" }, 500);
});

// Metadata is public; it never creates credentials or signing keys. The Moodle
// administrator selects the server, supporting cloud and private deployments.
moodlePairingRoutes.get("/discovery", async c => {
  if (!ltiMaterialsEnabled(c.env)) return c.json({ error: "LMS_SYNC_DISABLED" }, 404);
  const denied = await enforceThrottles(c.env, [{ scope: "moodle_pairing_ip", ident: clientIp(c) }]);
  if (denied) return throttledResponse(c, denied);
  const frontend = new URL(c.env.FRONTEND_URL || ltiConfig(c.env)!.toolOrigin);
  if (frontend.protocol !== "https:" || frontend.username || frontend.password || frontend.pathname !== "/" || frontend.search || frontend.hash) {
    return c.json({ error: "PAIRING_FAILED" }, 503);
  }
  return c.json({ toolOrigin: ltiConfig(c.env)!.toolOrigin, authorizationUrl: frontend.origin + "/moodle/connect",
    managementUrl: frontend.origin + '/moodle/manage', courseEntries: true, userVisibility: true,
    youtubeSourceProtocol: true, youtubeSources: features(c.env).youtube });
});

// Server-to-server exchange. Account/issuer are bound by the owner's expiring code.
moodlePairingRoutes.post("/exchange", async c => {
  const denied = await enforceThrottles(c.env, [{ scope: "moodle_pairing_ip", ident: clientIp(c) }]);
  if (denied) return throttledResponse(c, denied);
  const input = pairingExchangeSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "INVALID_PAIRING_REQUEST" }, 400);
  return c.json(await exchangeMoodlePairing(c.env, input.data));
});

moodlePairingRoutes.use("/", requireAuth(sessionMethod));
moodlePairingRoutes.use('/management', requireAuth(sessionMethod));
moodlePairingRoutes.post('/management', async c => {
  const allowed = [ltiConfig(c.env)!.toolOrigin, ...(c.env.CORS_ALLOW_ORIGIN ?? '').split(',').map(value => value.trim())];
  if (!c.req.header('Origin') || !allowed.includes(c.req.header('Origin')!)) return c.json({ error: 'INVALID_ORIGIN' }, 403);
  const denied = await enforceThrottles(c.env, [{ scope: 'moodle_pairing_user', ident: c.var.userId! }]);
  if (denied) return throttledResponse(c, denied);
  const input = moodleManagementRequest.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: 'INVALID_CONNECTION' }, 400);
  const context = await managementContext(c.env, c.var.userId!, input.data);
  return context ? c.json(context) : c.json({ error: 'UNAUTHORIZED' }, 401);
});
moodlePairingRoutes.post("/", async c => {
  const allowed = [ltiConfig(c.env)!.toolOrigin, ...(c.env.CORS_ALLOW_ORIGIN ?? "").split(",").map(value => value.trim())];
  if (!c.req.header("Origin") || !allowed.includes(c.req.header("Origin")!)) return c.json({ error: "INVALID_ORIGIN" }, 403);
  const denied = await enforceThrottles(c.env, [{ scope: "moodle_pairing_user", ident: c.var.userId! }]);
  if (denied) return throttledResponse(c, denied);
  const input = pairingRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "INVALID_MOODLE_URL" }, 400);
  return c.json(await issueMoodlePairing(c.env, c.var.userId!, input.data.moodleUrl, ltiConfig(c.env)!.toolOrigin, input.data.codeChallenge));
});
