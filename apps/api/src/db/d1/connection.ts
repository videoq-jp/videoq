import type {D1Database} from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";

/** SQL builders receive their own tables; Better Auth supplies its adapter schema.
 * Avoid rebuilding the unused relational API for every repository operation. */
export function createD1Connection(database: D1Database) {
  return drizzle(database);
}
