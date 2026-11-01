import { serve } from "@hono/node-server";
import pg from "pg";
import { nodeBindings, integerSetting } from "./node-config";
import { createNodeApp } from "./node-app";
import { postgresRateLimitBackend } from "./postgres-rate-limit";
import { RETENTION_CRON, runMaintenanceSweep, runScheduledMaintenance } from "../lib/scheduled-maintenance";

const env = nodeBindings(process.env);
const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: integerSetting(process.env, "DATABASE_POOL_MAX", 10, 2, 100),
  connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000,
});
// Better Auth calls rate limiting while already holding an application DB
// connection. A separate bounded pool prevents a saturated API pool deadlock.
const ratePool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: integerSetting(process.env, "RATE_LIMIT_POOL_MAX", 2, 1, 20),
  connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000,
});
pool.on("error", error => console.error(JSON.stringify({ event: "database_pool_error", error: error.message })));
ratePool.on("error", error => console.error(JSON.stringify({ event: "rate_limit_pool_error", error: error.message })));
env.DATABASE_POOL = pool;
env.RATE_LIMIT_BACKEND = postgresRateLimitBackend(ratePool);
const closePools = () => Promise.all([pool.end(), ratePool.end()]);

const command = process.argv[2] || "serve";
if (command === "maintenance" || command === "retention") {
  const client = await pool.connect();
  try {
    const lock = command === "retention" ? 2 : 1;
    const { rows } = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(997, $1) AS acquired", [lock]);
    if (rows[0].acquired) {
      try {
        if (command === "retention") await runScheduledMaintenance(env, RETENTION_CRON);
        else await runMaintenanceSweep(env);
        await pool.query("DELETE FROM runtime_rate_limits WHERE expires_at <= now()");
      } finally { await client.query("SELECT pg_advisory_unlock(997, $1)", [lock]); }
    } else {
      // A retry is necessary for retention; silently skipping could lose a day's cleanup.
      throw new Error("Another maintenance job is running; retry this job");
    }
  } finally { client.release(); await closePools(); }
} else if (command === "serve") {
  // Fail startup if the on-prem migration hasn't been applied.
  await pool.query("SELECT key FROM runtime_rate_limits LIMIT 0");
  const app = createNodeApp(env, integerSetting(process.env, "TRUST_PROXY_HOPS", 0, 0, 10));
  const server = serve({
    hostname: "0.0.0.0", port: integerSetting(process.env, "PORT", 8787, 1, 65535),
    fetch: (request, bindings) => app.fetch(request, bindings.incoming.socket.remoteAddress),
  }, info => console.log(JSON.stringify({ event: "api_listening", port: info.port })));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => { console.error("API shutdown deadline exceeded"); process.exit(1); }, 55_000);
    deadline.unref();
    server.close(() => {
      void app.drain().then(closePools).then(() => { clearTimeout(deadline); process.exit(0); });
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} else {
  await closePools();
  throw new Error(`Unknown runtime command: ${command}`);
}
