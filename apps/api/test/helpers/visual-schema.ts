import { URL } from "node:url";
import { readFileSync } from "node:fs";

// Integration tests use isolated search_path schemas rather than public.
export const visualSchema = readFileSync(new URL("../../drizzle/0032_segmented_visuals.sql", import.meta.url), "utf8")
  .replaceAll('"public".', '');
