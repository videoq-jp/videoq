import { readFileSync, readdirSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

/** Local workerd D1 binding, with the actual independent migration chain. */
export async function createD1Fixture(options:{r2?:boolean}={}) {
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: "export default { fetch() { return new Response('D1 fixture'); } }",
    compatibilityDate: "2026-08-20",
    d1Databases: ["DB"],
    r2Buckets:options.r2?["VIDEO_BUCKET"]:[],
  }));
  try {
    const database = await runtime.getD1Database("DB");
    const directory = new URL("../../drizzle-d1/", import.meta.url);
    for (const filename of readdirSync(directory).filter(name => name.endsWith(".sql")).sort()) {
      const migration = readFileSync(new URL(filename, directory), "utf8");
      const statements = migration.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean);
      for (let offset = 0; offset < statements.length; offset += 25) {
        await database.batch(statements.slice(offset, offset + 25).map(sql => database.prepare(sql)));
      }
    }
    return { database: database, bucket:options.r2?await runtime.getR2Bucket("VIDEO_BUCKET"):undefined, dispose: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
