import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema/sqlite/index.ts",
  out: "./drizzle-d1",
  dialect: "sqlite",
  strict: true,
  verbose: true,
});
