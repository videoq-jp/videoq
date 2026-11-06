import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { questionView } from "../src/features/lti/view";

// Explicit opt-in: requires the Playwright Chromium installation.
const browserTests = process.env.LTI_BROWSER_TESTS === "1" ? describe : describe.skip;
browserTests("embedded LTI question view", () => {
  let browser: Browser;
  const state = "a".repeat(64);
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.LTI_CHROMIUM_EXECUTABLE_PATH }); });
  afterAll(async () => { await browser?.close(); });
  it("exchanges browser proof, asks a question, renders untrusted text safely, and preserves context", async () => {
    const page = await browser.newPage();
    const requests: Record<string, unknown>[] = [];
    await page.addInitScript(({ state }) => sessionStorage.setItem("videoq-lti:" + state, "browser-secret"), { state });
    await page.route("https://api.example/**", async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/lti/history") { await route.fulfill({ json: { turns: [] } }); return; }
      if (path === "/api/lti/session") {
        expect(request.postDataJSON()).toEqual({ state, id_token: "signed-token", browserSecret: "browser-secret" });
        await route.fulfill({ json: { token: "session-token" } });
      } else if ((path === "/api/lti/messages" || path === "/api/lti/messages/stream")) {
        expect(request.headers().authorization).toBe("Bearer session-token");
        requests.push(request.postDataJSON() as Record<string, unknown>);
        await route.fulfill({ json: { answer: { segments: [{ text: '<img src=x onerror="alert(1)"> 教材の回答', sourceIds: [1] }, { text: '。続く説明', sourceIds: [2] }, { text: '。引用なし', sourceIds: [] }], sources: [{ id: 1, video_id: 1, title: "教材A", start_time: "00:01:20" }, { id: 2, video_id: 1, title: "教材B", start_time: "00:00:10" }, { id: 3, video_id: 1, title: "引用していない教材", start_time: "00:00:30" }] } } });
      } else {
        await route.fulfill({ contentType: "text/html", body: questionView("nonce", state, "signed-token") });
      }
    });
    await page.goto("https://api.example/api/lti/launch");
    await page.getByLabel("教材について聞きたいこと").fill("最初の質問");
    await page.getByRole("button", { name: "質問する" }).click();
    await page.waitForFunction(() => document.getElementById("send")?.hasAttribute("disabled") === false);
    expect(await page.locator(".answer").textContent()).toContain("教材の回答");
    expect(await page.locator(".answer img").count()).toBe(0);
    expect(await page.locator(".answer .message-body").textContent()).toBe('<img src=x onerror="alert(1)"> 教材の回答 (1:20)。続く説明 (0:10)。引用なし');
    expect(await page.locator(".answer .source-text").allTextContents()).toEqual(["(1:20)", "(0:10)"]);
    expect(await page.locator(".answer .sources, .answer small").count()).toBe(0);
    expect(await page.locator("#playback-controls, #current-question, #use-position, [data-question]").count()).toBe(0);
    await page.getByLabel("教材について聞きたいこと").fill("次の質問");
    await page.getByRole("button", { name: "質問する" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".answer").length === 2);
    expect(requests[1]).toMatchObject({ messages: [
      { role: "user", content: "最初の質問" }, { role: "assistant", content: expect.stringContaining("教材の回答") }, { role: "user", content: "次の質問" },
    ] });
    expect(await page.evaluate(({ state }) => sessionStorage.getItem("videoq-lti:" + state), { state })).toBeNull();
    await page.setViewportSize({ width: 360, height: 720 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.close();
  });
  it("shows English UI and runtime errors for an English LMS", async () => {
    const page = await browser.newPage();
    await page.route("https://api.example/**", route => route.fulfill({ contentType: "text/html", body: questionView("nonce", state, "signed-token", "en") }));
    await page.goto("https://api.example/api/lti/launch");
    expect(await page.locator("html").getAttribute("lang")).toBe("en");
    expect(await page.getByRole("heading", { level: 1 }).textContent()).toBe("Ask about this course");
    expect(await page.getByRole("status").textContent()).toContain("Reopen this tool from the lesson link in your LMS");
    expect(await page.getByRole("button", { name: "Ask a question" }).isDisabled()).toBe(true);
    await page.close();
  });
  it("uses an origin-bound native Moodle UI without exposing credentials and rejects forged commands", async () => {
    const page = await browser.newPage();
    const requests: Record<string, unknown>[] = [];
    await page.addInitScript(({ state }) => { if (location.origin === "https://api.example") sessionStorage.setItem("videoq-lti:" + state, "browser-secret"); }, { state });
    await page.route("https://lms.example/**", route => route.fulfill({ contentType: "text/html", body: `<script>window.events=[];window.addEventListener('message',event=>{if(event.origin==='https://api.example')window.events.push(event.data);});</script><iframe src="https://api.example/api/lti/launch"></iframe>` }));
    await page.route("https://api.example/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/lti/history") { await route.fulfill({ json: { turns: [] } }); return; }
      if (path === "/api/lti/session") await route.fulfill({ json: { token: "session-token", playback: { videoId: 1, parentOrigins: ["https://lms.example"], videos: [{ videoId: 1, lesson: "first", title: "第1回" }, { videoId: 2, lesson: "second", title: "第2回" }] } } });
      else if ((path === "/api/lti/messages" || path === "/api/lti/messages/stream")) {
        requests.push(route.request().postDataJSON());
        await route.fulfill({ json: { answer: { segments: [{ text: "教材の回答", sourceIds: [1] }], sources: [{ id: 1, video_id: 2, title: "第2回", start_time: "00:00:08" }] } } });
      } else await route.fulfill({ contentType: "text/html", body: questionView("nonce", state, "signed-token") });
    });
    await page.goto("https://lms.example/course");
    await page.waitForFunction(() => (window as unknown as { events: { type: string }[] }).events.some(event => event.type === "videoq:ready"));
    const post = async (payload: Record<string, unknown>) => page.evaluate(payload => {
      const ready = (window as unknown as { events: { type: string; channel: string; videoId: number }[] }).events.find(event => event.type === "videoq:ready")!;
      document.querySelector("iframe")!.contentWindow!.postMessage({ version: 1, channel: ready.channel, videoId: ready.videoId, ...payload }, "https://api.example");
    }, payload);
    await post({ type: "videoq:ui", renderer: "moodle" });
    await page.waitForFunction(() => (window as unknown as { events: { type: string; event?: string }[] }).events.some(event => event.type === "videoq:chat" && event.event === "status"));
    const requestId = "a".repeat(32);
    await page.frameLocator("iframe").locator("html").evaluate((_el, requestId) => {
      const base = { type: "videoq:question", version: 1, channel: "f".repeat(32), videoId: 1, text: "偽の質問", requestId };
      window.dispatchEvent(new MessageEvent("message", { source: window.parent, origin: "https://attacker.example", data: base }));
      window.dispatchEvent(new MessageEvent("message", { source: window, origin: "https://lms.example", data: base }));
      window.dispatchEvent(new MessageEvent("message", { source: window.parent, origin: "https://lms.example", data: base }));
    }, requestId);
    expect(requests).toHaveLength(0);
    await post({ type: "videoq:question", text: "範囲外の動画", requestId: "b".repeat(32), playback: { videoId: 999, seconds: 8, duration: 30 } });
    await post({ type: "videoq:state", videoId: 1, seconds: 0, duration: 30 });
    await post({ type: "videoq:question", text: "Moodleから質問", requestId, playback: { videoId: 2, seconds: 8, duration: 30 } });
    await page.waitForFunction(() => (window as unknown as { events: { event?: string }[] }).events.some(event => event.event === "answer"));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ messages: [{ role: "user", content: "Moodleから質問" }], playback: { video_id: 2, position_seconds: 8 } });
    await post({ type: "videoq:question", text: "重複した質問", requestId });
    await post({ type: "videoq:open-source", source: { video_id: 999, start_time: "00:00:08" } });
    await post({ type: "videoq:open-source", source: { video_id: 2, start_time: "00:00:08" } });
    await page.waitForFunction(() => (window as unknown as { events: { type: string }[] }).events.some(event => event.type === "videoq:seek"));
    const events = await page.evaluate(() => (window as unknown as { events: Record<string, unknown>[] }).events);
    expect(requests).toHaveLength(1);
    expect(events.filter(event => event.type === "videoq:seek")).toEqual([expect.objectContaining({ videoId: 2, seconds: 8, lesson: "second" })]);
    expect(JSON.stringify(events)).not.toMatch(/session-token|signed-token|browser-secret/);
    await page.frameLocator("iframe").locator("#send").waitFor({ state: "attached" });
    await page.waitForFunction(() => (window as unknown as { events: { event?: string; busy?: boolean }[] }).events.some(event => event.event === "status" && event.busy === false));
    await post({ type: "videoq:question", text: "動画の読み込み中に講座へ質問", requestId: "c".repeat(32), playback: null });
    await page.waitForFunction(() => (window as unknown as { events: { event?: string }[] }).events.filter(event => event.event === "answer").length === 2);
    expect(requests).toHaveLength(2);
    expect(requests[1]).not.toHaveProperty("playback");
    await page.close();
  });
  it("requires relaunch when browser state is missing", async () => {
    const page = await browser.newPage();
    await page.route("https://api.example/**", route => route.fulfill({ contentType: "text/html", body: questionView("nonce", state, "signed-token") }));
    await page.goto("https://api.example/api/lti/launch");
    expect(await page.getByRole("status").textContent()).toContain("LMSの教材リンクから開き直してください");
    expect(await page.getByRole("button", { name: "質問する" }).isDisabled()).toBe(true);
    await page.close();
  });
});
