import { URL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";
import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/types/bindings";
import { chatAnswerSchema, type ChatStreamEvent } from "@videoq/trpc/chat";
import { privateJsonReport } from "./support/private-report";

const enabled = process.env.STRUCTURED_ANSWER_LIVE === "1";
const varsPath = new URL("../.dev.vars", import.meta.url);
const vars = enabled && existsSync(varsPath) ? parse(readFileSync(varsPath)) : {};
const env = Object.fromEntries(["OPENROUTER_FEDERATION_POLICY_ID", "OPENROUTER_FEDERATION_AUDIENCE", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"].map(key =>
  [key, process.env[key] ?? vars[key]])) as unknown as Bindings;
const scenes = [
  { videoId: 60, videoTitle: "Rotation", startTime: "00:01:00", endTime: "00:02:00", content: "A two-dimensional rotation matrix is R(theta) = [[cos(theta), -sin(theta)], [sin(theta), cos(theta)]]. It changes direction and preserves length. At 90 degrees, (1,0) becomes (0,1)." },
  { videoId: 61, videoTitle: "Python", startTime: "00:03:00", endTime: "00:04:00", content: "In Python, a = [10, 20]; a[1] evaluates to 20 because indexing starts at zero. print(a[1]) prints 20." },
];
vi.mock("../src/repositories/vector-repository", () => ({ openSceneSearch: async () => ({
  search: async () => scenes, close: async () => {},
}) }));
vi.mock("../src/repositories/course-repository", () => ({ getCourseInfo: async () => ({
  id: 3, name: "Matrices and Python", description: "", video_count: 2,
  videos: scenes.map((s, order) => ({ id: s.videoId, title: s.videoTitle, description: "", order, status: "completed" })),
}) }));
const { streamRag } = await import("../src/lib/rag");
const cases = [
  { id: "rotation-ja", course: true, locale: "ja", query: "回転行列はベクトルに何をしますか？簡潔に説明してください。" },
  { id: "rotation-en", course: true, locale: "en", query: "What does a rotation matrix do to a vector? Explain briefly." },
  { id: "math-ja", course: true, locale: "ja", query: "2次元の回転行列の式をTeXで示し、90度回転の例を簡潔に説明してください。" },
  { id: "code-en", course: true, locale: "en", query: "Show the Python indexing example from the course in a fenced code block and explain what a[1] returns." },
  { id: "multiple-en", course: true, locale: "en", query: "Briefly summarize both rotation matrices and the Python example in this course." },
  { id: "metadata-ja", course: true, locale: "ja", query: "この講座には何本の動画がありますか？" },
  { id: "no-course-ja", course: false, locale: "ja", query: "動画について質問するにはどうしたらよいですか？" },
  { id: "no-course-en", course: false, locale: "en", query: "How can I ask questions about my videos?" },
];

// Fixed before comparison: 3 repeats; no request failures; all factual claims
// manually checked against the fixture; no missing/incorrect source links;
// per-mode median first text/completion <= baseline * 1.25 + 250 ms.
// Usage and request counts are reported, not hidden by aggregate timings.
describe.skipIf(!enabled)("structured answer comparison (paid, opt-in)", () => {
  it("records identical fixtures and transport usage", async () => {
    const report = privateJsonReport(process.env.STRUCTURED_ANSWER_REPORT);
    console.log(`Structured answer report: ${report.path}`);
    const originalFetch = globalThis.fetch;
    const results: unknown[] = [];
    let rejectedIds = 0;
    const warn = console.warn;
    const log = vi.spyOn(console, "warn").mockImplementation((entry, ...args) => {
      if (typeof entry === "string" && entry.startsWith('{"event":"chat_citations_rejected"')) {
        const counts = JSON.parse(entry);
        rejectedIds += counts.invalid_id + counts.unknown_id;
      } else warn(entry, ...args);
    });
    let browser: Awaited<ReturnType<typeof import("./support/answer-browser").answerBrowser>> | undefined;
    try {
      browser = process.env.STRUCTURED_ANSWER_BROWSER === "1"
        ? await (await import("./support/answer-browser")).answerBrowser() : undefined;
      for (const scenario of cases.filter(s => !process.env.STRUCTURED_ANSWER_CASE || s.id === process.env.STRUCTURED_ANSWER_CASE)) for (let repeat = 0; repeat < 3; repeat++) {
        let calls = 0;
        rejectedIds = 0;
        let inputTokens = 0;
        let outputTokens = 0;
        const captures: Promise<void>[] = [];
        globalThis.fetch = async (...args) => {
          calls++;
          const response = await originalFetch(...args);
          captures.push(response.clone().text().then(body => {
            const entries = response.headers.get("content-type")?.includes("text/event-stream")
              ? body.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
              : [JSON.parse(body)];
            for (const entry of entries) if (entry.usage) {
              inputTokens += entry.usage.prompt_tokens ?? 0;
              outputTokens += entry.usage.completion_tokens ?? 0;
            }
          }));
          return response;
        };
        let start = performance.now();
        let firstTextMs: number | null = null;
        let firstCitationMs: number | null = null;
        let content = "";
        let final: unknown;
        const consume = async (send: (event: ChatStreamEvent) => void) => {
          start = performance.now();
          for await (const chunk of streamRag(env, {
            messages: [{ role: "user", content: scenario.query }], locale: scenario.locale,
            ownerUserId: "00000000-0000-4000-8000-000000000005",
            courseId: scenario.course ? 3 : null, videoIds: scenario.course ? [60, 61] : null,
          })) {
            if ("part" in chunk && chunk.part.type === "text" && chunk.part.text) {
              firstTextMs ??= performance.now() - start;
              content += chunk.part.text;
            }
            if ("final" in chunk) final = chunk.final;
            if ("part" in chunk && chunk.part.type === "citation") firstCitationMs ??= performance.now() - start;
            if ("part" in chunk) send(chunk.part.type === "text" ? { ...chunk.part, type: "text_delta" } : chunk.part);
            else if ("source" in chunk) send({ type: "source", source: chunk.source });
            else if ("searching" in chunk) send({ type: "searching", search_id: chunk.searchId, query: chunk.searching });
            else if ("searchCompleted" in chunk) send({ type: "search_completed", search_id: chunk.searchCompleted.id, query: chunk.searchCompleted.query, result_count: chunk.searchCompleted.count });
          }
          send({ type: "done", chat_log_id: scenario.course ? 1 : null, feedback: null });
        };
        let completionMs = 0;
        const measuredConsume: typeof consume = async send => { await consume(send); completionMs = performance.now() - start; };
        const visible = browser ? await browser.run(scenario.course, scenario.query, measuredConsume) : undefined;
        if (!browser) await measuredConsume(() => {});
        await Promise.all(captures);
        expect(content.trim()).not.toBe("");
        const answer = chatAnswerSchema.parse((final as { answer: unknown }).answer);
        const references = [...new Set(answer.segments.flatMap(segment => segment.sourceIds))].sort();
        const expected = scenario.id === "multiple-en" ? [1, 2] : scenario.id === "code-en" ? [2]
          : scenario.id.startsWith("rotation-") || scenario.id === "math-ja" ? [1] : [];
        expect.soft(references).toEqual(expected);
        expect.soft(rejectedIds).toBe(0);
        expect.soft(content).toBe(answer.segments.map(segment => segment.text).join(""));
        if (scenario.id === "multiple-en") expect.soft(answer.segments.slice(1).every(segment => /^\s/.test(segment.text))).toBe(true);
        if (scenario.id === "code-en") expect.soft(content).toMatch(/```[\s\S]*print\(a\[1\]\)[\s\S]*```/);
        if (scenario.id === "math-ja") expect.soft(content).toMatch(/\\\[|\$\$/);
        if (visible) expect.soft(visible.mathErrors).toBe(0);
        results.push({ id: scenario.id, repeat, course: scenario.course, firstTextMs, firstCitationMs,
          completionMs, calls, repairCalls: 0, rejectedIds, inputTokens, outputTokens, content, final, ...visible });
        report.write({
          model: env.LLM_MODEL, results,
        });
      }
    } finally { report.close(); globalThis.fetch = originalFetch; log.mockRestore(); await browser?.close(); }
  }, 900_000);
});
