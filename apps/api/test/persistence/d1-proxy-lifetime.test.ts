import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("keeps all eight concurrent D1 batch arguments alive across proxy transport and GC", () => {
  // A separate process exposes GC only for this regression, without changing
  // Vitest's flags or relying on nondeterministic CI memory pressure.
  const program = `
    import { Miniflare, convertV4MiniflareOptions } from "miniflare";
    import { setTimeout as delay } from "node:timers/promises";
    const { retainD1BatchStatements } = await import(process.argv[1]);
    const runtime = new Miniflare(convertV4MiniflareOptions({
      modules: true, script: 'export default { fetch() { return new Response("ok"); } }',
      compatibilityDate: "2026-08-20", d1Databases: ["DB"],
    }));
    const dispatch = runtime.dispatchFetch;
    let delayed = false, inFlight = 0, maximum = 0;
    runtime.dispatchFetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      if (delayed && headers.get("MF-Op") === "CALL" && headers.get("MF-Op-Key") === "batch") {
        inFlight++;
        maximum = Math.max(maximum, inFlight);
        try { await delay(400); } finally { inFlight--; }
      }
      return dispatch(input, init);
    };
    try {
      const database = retainD1BatchStatements(await runtime.getD1Database("DB"));
      await database.prepare("CREATE TABLE replay(id INTEGER)").run();
      // Warm Miniflare's async method detection before exercising the async bridge.
      await database.batch([database.prepare("INSERT INTO replay VALUES(0)")]);
      delayed = true;
      const timer = setInterval(() => globalThis.gc(), 10);
      try {
        await Promise.all(Array.from({ length: 8 }, (_, i) => database.batch([
          database.prepare("INSERT INTO replay VALUES(?)").bind(i + 1),
        ])));
      } finally { clearInterval(timer); }
      console.log(JSON.stringify({ rows: await database.prepare("SELECT count(*) AS n FROM replay").first("n"), maximum }));
    } finally { await runtime.dispose(); }
  `;
  const output = execFileSync(process.execPath, ["--expose-gc", "--eval", program,
    new URL("./d1-fixture.ts", import.meta.url).href], { encoding: "utf8" });
  expect(JSON.parse(output.trim())).toEqual({ rows: 9, maximum: 8 });
});
