import { readFileSync, readdirSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

/** Local workerd D1 binding, with the actual independent migration chain. */
type FixtureOptions = {
  r2?: boolean;
  worker?: {
    script: string;
    bindings: Record<string, string>;
    httpsKey: string;
    httpsCert: string;
  };
};
export async function createD1Fixture(options: FixtureOptions = {}) {
  let outboundRequests=0;
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: options.worker?.script??"export default { fetch() { return new Response('D1 fixture'); } }",
    compatibilityDate: "2026-08-20",
    ...(options.worker ? {
      compatibilityFlags: ['nodejs_compat'],
      bindings: options.worker.bindings,
      host: '127.0.0.1', port: 0, https: true,
      httpsKey: options.worker.httpsKey, httpsCert: options.worker.httpsCert,
      outboundService: async () => {
        outboundRequests++;
        return new Response('External requests forbidden', {status: 502});
      },
    } : {}),
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
    return {
      database,
      bucket: options.r2 ? await runtime.getR2Bucket("VIDEO_BUCKET") : undefined,
      origin: options.worker ? (await runtime.ready).origin : undefined,
      outboundRequests: () => outboundRequests,
      dispose: () => runtime.dispose(),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
