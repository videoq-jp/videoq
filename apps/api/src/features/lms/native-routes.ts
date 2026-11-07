import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../../types/bindings";
import { ApiError, toErrorBody } from "../../shared/errors";
import { clientIp, enforceThrottles, throttledResponse } from "../../lib/rate-limit";
import { mountLearningRoutes, type LearningRefusal } from "../lti/learning-routes";
import { digest } from "../lti/store";
import { authorizeNativeRequest } from "./native-auth";

export const moodleNativeRoutes = new Hono<AppEnv>();
const prefix = "/api/lms/native";
const operations = new Set(["/materials", "/transcript", "/history", "/messages", "/messages/stream",
  "/feedback", "/qa", "/conversations", "/management", "/tags", "/reports"]);
const refuse: LearningRefusal = (c, status = 400) =>
  c.json(toErrorBody(status === 401 ? "UNAUTHORIZED" : "FORBIDDEN", "The Moodle learning request is unavailable."), status);
const limit = (maxSize: number): MiddlewareHandler<AppEnv> => bodyLimit({
  maxSize,
  onError: context => context.json(toErrorBody("VALIDATION_ERROR", "The learning request is too large."), 413),
});
const ordinaryLimit = limit(128 * 1024), managementLimit = limit(5 * 1024 * 1024);

moodleNativeRoutes.use("*", async (c: Context<AppEnv, string>, next) => {
  c.header("Cache-Control", "private, no-store");
  if (!operations.has(c.req.path.slice(prefix.length))) return c.notFound();
  if (c.req.method !== "POST") return c.json(toErrorBody("VALIDATION_ERROR", "POST is required."), 405);
  if (c.req.header("Origin") !== undefined || new URL(c.req.url).search) return refuse(c, 403);
  return (c.req.path.endsWith("/management") ? managementLimit : ordinaryLimit)(c, next);
});
moodleNativeRoutes.use("*", async (c: Context<AppEnv, string>, next) => {
  const denied = await enforceThrottles(c.env, [{ scope: "lti_request_ip", ident: clientIp(c) }]);
  if (denied) return throttledResponse(c, denied);
  const assertion = c.req.header("Authorization")?.match(/^Bearer (\S+)$/)?.[1];
  if (!assertion) return refuse(c, 401);
  // Hash the bounded original bytes without consuming the downstream body.
  const bodySha256 = await digest(await c.req.raw.clone().text());
  const authorization = await authorizeNativeRequest(c.env, assertion, c.req.path.slice(prefix.length), bodySha256);
  c.set("nativeLearningAuthorization", authorization);
  await next();
});
moodleNativeRoutes.onError((error, c) => {
  if (error instanceof ApiError) return c.json(toErrorBody(error.code, error.expose ? error.message : "The Moodle learning request is unavailable."), error.status);
  console.error(JSON.stringify({ event: "moodle_native_request_failed" }));
  return c.json(toErrorBody("INTERNAL_ERROR", "The Moodle learning service is unavailable."), 503);
});
mountLearningRoutes(moodleNativeRoutes, c => {
  const authorization = c.get("nativeLearningAuthorization");
  return Promise.resolve(authorization ?? { error: refuse(c, 401) });
}, refuse);
