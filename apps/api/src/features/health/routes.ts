import { pingPersistence } from "../../persistence/factory";
import { toErrorBody } from "../../shared/errors";
import { Hono } from "hono";
import type { AppEnv } from "../../types/bindings";

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get("/health", (c) =>
  c.json({ data: { status: "ok", env: c.env.ENVIRONMENT } }, 200),
);

healthRoutes.get("/ready", async (c) => {
  try {
    const dbOk = await pingPersistence(c.env);
    if (!dbOk) {
      return c.json(toErrorBody("DB_UNREADY", "Database check failed"), 503);
    }
    return c.json({ data: { status: "ready", db: "ok" } }, 200);
  } catch {
    return c.json(toErrorBody("DB_UNREADY", "Database unreachable"), 503);
  }
});
