import { readFileSync, readdirSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

/** Local workerd D1 binding, with the actual independent migration chain. */
type FixtureOptions = {
  workflowScript?: string;
  r2?: boolean;
  beforeMigration?: string;
  worker?: {
    script: string;
    bindings: Record<string, string>;
    httpsKey: string;
    httpsCert: string;
  };
};
/** Miniflare's host proxy can finalize statement handles before an async batch
 * reaches workerd. Keep only in-flight arguments alive; do not serialize/retry
 * database operations or change the real D1 transaction semantics. */
export function retainD1BatchStatements(database: D1Database): D1Database {
  const pending = new Set<{ statements: D1PreparedStatement[] }>();
  const batch = async <T = unknown>(statements: D1PreparedStatement[]) => {
    const operation = { statements };
    pending.add(operation);
    try { return await database.batch<T>(statements); }
    finally { pending.delete(operation); }
  };
  return new Proxy(database, {
    get(target, key) { return key === "batch" ? batch : Reflect.get(target, key); },
  });
}

export async function createD1Fixture(options: FixtureOptions = {}) {
  let outboundRequests=0;
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: options.workflowScript ?? options.worker?.script??"export default { fetch() { return new Response('D1 fixture'); } }",
    compatibilityDate: "2026-08-20",
    ...(options.workflowScript ? {compatibilityFlags:["nodejs_compat"],workflows:{SEARCH_INDEX_WORKFLOW:{name:"recovery-probe",className:"RecoveryWorkflow"}},bindings:{DEPLOYMENT_EDITION:"cloud",PERSISTENCE_BACKEND:"d1",EMBEDDING_PROVIDER:"workers-ai",EMBEDDING_PROFILE:"embeddinggemma2"}} : {}),
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
    const database = retainD1BatchStatements(await runtime.getD1Database("DB"));
    const directory = new URL("../../drizzle-d1/", import.meta.url);
    const migrations = readdirSync(directory).filter(name => name.endsWith(".sql")).sort();
    if (options.beforeMigration && !migrations.includes(options.beforeMigration)) throw new Error("Unknown fixture migration boundary");
    for (const filename of migrations.filter(name => !options.beforeMigration || name < options.beforeMigration)) {
      const migration = readFileSync(new URL(filename, directory), "utf8");
      const statements = migration.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean);
      for (let offset = 0; offset < statements.length; offset += 25) {
        await database.batch(statements.slice(offset, offset + 25).map(sql => database.prepare(sql)));
      }
    }
    return {
      runtime,
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
