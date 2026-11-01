import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium, type Browser, type Page } from "playwright";
import type { ChatStreamEvent } from "@videoq/trpc/chat";

/** Real browser/hook/controller/renderer, with fixed retrieval and no persistence latency. */
export async function answerBrowser() {
  const root = fileURLToPath(new URL("../../../..", import.meta.url));
  const webRequire = createRequire(`${root}/apps/web/package.json`);
  const { createServer } = await import(webRequire.resolve("vite")) as typeof import("vite");
  const react = (await import(webRequire.resolve("@vitejs/plugin-react-swc"))).default;
  let respond: ((send: (event: ChatStreamEvent) => void) => Promise<void>) | undefined;
  const server = await createServer({
    configFile: false,
    root: `${root}/apps/web`,
    cacheDir: `${root}/apps/api/node_modules/.vite-answer-benchmark`,
    optimizeDeps: { entries: [`${root}/apps/api/test/support/answer-browser-page.tsx`] },
    plugins: [react(), { name: "answer-benchmark", configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith("/api/chat/messages/stream")) {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            void respond!(event => res.write(`data: ${JSON.stringify(event)}\n\n`))
              .catch(() => res.write(`data: ${JSON.stringify({ type: "error", code: "BENCHMARK_FAILED", message: "Benchmark failed" })}\n\n`))
              .finally(() => res.end());
          } else if (req.url?.startsWith("/benchmark")) {
            res.setHeader("content-type", "text/html");
            void server.transformIndexHtml("/benchmark", `<!doctype html><html><body><div id="root"></div><script type="module" src="/@fs/${root}/apps/api/test/support/answer-browser-page.tsx"></script></body></html>`).then(html => res.end(html));
          } else next();
        });
    } }],
    define: { "import.meta.env.VITE_API_URL": JSON.stringify("/api") },
    resolve: { alias: [
      { find: "@", replacement: `${root}/apps/web/src` },
      { find: "i18next", replacement: webRequire.resolve("i18next") },
      { find: "react-i18next", replacement: webRequire.resolve("react-i18next") },
    ] },
    server: { host: "127.0.0.1", port: 0, hmr: false, fs: { allow: [root] } },
  });
  let browser: Browser | undefined;
  let page: Page;
  const close = async () => {
    try { await browser?.close(); }
    finally { await server.close(); }
  };
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    async run(course: boolean, query: string, consume: NonNullable<typeof respond>) {
      respond = consume;
      await page.goto(`${server.resolvedUrls!.local[0]}benchmark?course=${course ? "3" : ""}`);
      await page.getByRole("textbox").fill(query);
      await page.getByRole("button", { name: "Send" }).click();
      await page.waitForFunction(() => (window as any).benchmark?.completed, undefined, { timeout: 120_000 });
      return page.evaluate(() => {
        const result = (window as any).benchmark;
        return { firstVisibleTextMs: result.firstVisibleTextMs, renderedCompletionMs: result.renderedCompletionMs,
          mathErrors: document.querySelectorAll('#answer .katex-error').length,
          renderedText: document.querySelector("#answer")?.textContent ?? "" };
      });
    },
    close,
  };
}
