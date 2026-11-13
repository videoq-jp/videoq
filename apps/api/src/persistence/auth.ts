import { withDb } from "../db/pool";
import { createAuth } from "../lib/auth";
import type { Bindings } from "../types/bindings";
import { persistenceBackend } from "./backend";

/** Own the database lifetime for an entire Better Auth operation. */
export async function withAuth<T>(
  env: Bindings,
  operation: (auth: ReturnType<typeof createAuth>) => Promise<T>,
  profile: "full" | "browser" = "full",
): Promise<T> {
  if (persistenceBackend(env) === "postgres") return withDb(env, db => operation(createAuth(env, db, profile)));
  if (!env.DB) throw new Error("D1 DB binding is required");
  const { createD1Auth } = await import("./d1/auth");
  return operation(createD1Auth(env, env.DB, profile));
}
