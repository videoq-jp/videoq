import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, it } from "vitest";

it("uses internal MCP in a production-like Worker without unsafe eval", async () => {
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(new URL("../", import.meta.url)), contents: `
      import { connectEvidenceMcp } from './src/integrations/evidence-mcp';
      export default { async fetch(request) {
        if (new URL(request.url).pathname === '/agent') {
          const { runRag } = await import('./src/lib/rag');
          return Response.json(await runRag({ OPENAI_API_KEY: 'fixture', OPENAI_BASE_URL: 'https://provider.test/v1', LLM_MODEL: 'fixture-model', VIDEO_VISUAL_ENABLED: 'false' },
            { ownerUserId: 'owner', courseId: 1, videoIds: [], messages: [{ role: 'user', content: 'topic' }], locale: 'en' }));
        }
        let codeGenerationBlocked = false;
        try { new Function('return 1')(); } catch { codeGenerationBlocked = true; }
        const connection = await connectEvidenceMcp({ VIDEO_VISUAL_ENABLED: 'false' },
          { ownerUserId: 'owner', videoIds: [] }, new AbortController().signal);
        try {
          const { tools } = await connection.client.listTools();
          const result = await connection.client.callTool({ name: 'search_scenes', arguments: { query: 'topic', video_ids: null } });
          return Response.json({ codeGenerationBlocked, names: tools.map(tool => tool.name), result });
        } finally { await connection.close(); }
      }};` },
    bundle: true, write: false, format: "esm", platform: "node", target: "es2022",
    conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*"], logLevel: "silent",
  });
  let modelCalls = 0;
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-08-20", compatibilityFlags: ["nodejs_compat"],
    outboundService: async request => {
      expect(new URL(request.url).href).toBe("https://provider.test/v1/chat/completions");
      const input = await request.json() as { messages: { role: string }[] };
      modelCalls++;
      const searched = input.messages.some(message => message.role === "tool");
      return Response.json({ choices: [{ finish_reason: searched ? "stop" : "tool_calls", message: searched
        ? { role: "assistant", content: JSON.stringify({ segments: [{ text: "No evidence.", sourceIds: [] }] }) }
        : { role: "assistant", content: null, tool_calls: [{ id: "search", type: "function", function: {
          name: "search_scenes", arguments: JSON.stringify({ query: "topic", video_ids: null }),
        } }] },
      }] });
    },
  }));
  try {
    const response = await runtime.dispatchFetch("http://worker.test");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ codeGenerationBlocked: true, names: expect.arrayContaining(["search_scenes"]),
      result: { structuredContent: { result: expect.stringContaining("No subtitle scenes matched") } } });
    const answer = await runtime.dispatchFetch("http://worker.test/agent");
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ answer: { segments: [{ text: "No evidence." }] } });
    expect(modelCalls).toBe(2);
  } finally { await runtime.dispose(); }
}, 30_000);
