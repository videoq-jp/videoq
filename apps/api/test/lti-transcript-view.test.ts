import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { questionView } from "../src/features/lti/view";

const browserTests = process.env.LTI_BROWSER_TESTS === "1" ? describe : describe.skip;
browserTests("LTI transcript reader", () => {
  let browser: Browser;
  const state = "a".repeat(64);
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.LTI_CHROMIUM_EXECUTABLE_PATH }); });
  afterAll(async () => { await browser?.close(); });
  async function fixture(page: Page) {
    let revoked = false;
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    await page.addInitScript(({ state }) => {
      if (location.origin === "https://api.example") sessionStorage.setItem("videoq-lti:" + state, "browser-secret");
    }, { state });
    await page.route("https://api.example/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === "/api/lti/launch") {
        await route.fulfill({ contentType: "text/html", body: questionView("nonce", state, "signed-token", "en") }); return;
      }
      expect(request.headers().authorization || path).toBe(path === "/api/lti/session" ? path : "Bearer private-session-token");
      if (path === "/api/lti/session") await route.fulfill({ json: { token: "private-session-token", features: { transcripts: true },
        playback: { videoId: 1, parentOrigins: ["https://lms.example"], videos: [{ videoId: 1, lesson: "first", title: "First" }] } } });
      else if (path === "/api/lti/history") await route.fulfill({ json: { turns: [] } });
      else if (path === "/api/lti/materials") await route.fulfill({ json: { permissions: { viewTranscript: true },
        videos: [{ videoId: 1, lesson: "first", title: "<img src=x> First" }] } });
      else if (path === "/api/lti/transcript") {
        const body = request.postDataJSON(); requests.push({ path, body });
        if (revoked) { await route.fulfill({ status: 403, json: { error: "denied" } }); return; }
        await route.fulfill({ json: { videoId: 1, title: "First", cues: [{ startTime: "00:00:01,000", startSeconds: 1,
          endSeconds: 2, text: body.cursor ? "Second cue" : "<img src=x onerror=alert(1)> First cue" }], nextCursor: body.cursor ? null : 1 } });
      } else throw new Error("Unexpected request: " + path);
    });
    return { requests, revoke: () => { revoked = true; } };
  }
  it("reads and pages escaped transcript cues in the embedded UI and clears them on revocation", async () => {
    const page = await browser.newPage();
    const service = await fixture(page);
    await page.goto("https://api.example/api/lti/launch");
    await page.locator("#course-materials summary").click();
    await page.waitForFunction(() => document.querySelectorAll("#material-cues li").length === 1);
    expect(await page.locator("#material-cues").textContent()).toContain("<img src=x onerror=alert(1)>");
    expect(await page.locator("#course-materials img").count()).toBe(0);
    await page.getByRole("button", { name: "Show more" }).click();
    await page.waitForFunction(() => document.querySelectorAll("#material-cues li").length === 2);
    expect(service.requests.map(request => request.body)).toEqual([{ videoId: 1, cursor: 0 }, { videoId: 1, cursor: 1 }]);
    service.revoke();
    await page.getByRole("button", { name: "Refresh lessons" }).click();
    await page.waitForFunction(() => document.querySelector("#material-status")?.textContent?.includes("Unable"));
    expect(await page.locator("#material-cues li").count()).toBe(0);
    await page.setViewportSize({ width: 360, height: 720 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.close();
  });
  // Cross-repository contract: point at the candidate companion checkout.
  it.skipIf(!process.env.LTI_MOODLE_PLUGIN_PATH)("reads through the actual Moodle reader without exposing credentials or accepting forged replies", async () => {
    const plugin = process.env.LTI_MOODLE_PLUGIN_PATH!;
    const labels: Record<string, string> = { heading: "Lesson transcripts", lesson: "Lesson", refresh: "Refresh lessons",
      more: "Show more", empty: "No transcript", error: "Unable to load", seek: "Jump to" };
    const markup = (await readFile(join(plugin, "templates/transcript.mustache"), "utf8"))
      .replace(/\{\{![\s\S]*?\}\}/g, "").replace(/\{\{(\w+)\}\}/g, (_, key) => labels[key]);
    const script = await readFile(join(plugin, "transcript.js"), "utf8");
    const page = await browser.newPage();
    const service = await fixture(page);
    await page.route("https://lms.example/**", route => route.fulfill({ contentType: "text/html", body: `<div class="local-videoq-workspace" data-videoq-origin="https://api.example">${markup}<iframe id="videoq-questions" src="https://api.example/api/lti/launch"></iframe></div>
<script>${script}</script><script>
window.received=[];window.seeks=[];
document.querySelector('.local-videoq-workspace').addEventListener('videoq:seek-citation',event=>window.seeks.push(event.detail));
window.addEventListener('message',event=>{if(event.origin!=='https://api.example')return;window.received.push(event.data);
 if(event.data.type==='videoq:ready')event.source.postMessage({type:'videoq:ui',version:1,renderer:'moodle',channel:event.data.channel,videoId:event.data.videoId},event.origin);
});</script>` }));
    await page.goto("https://lms.example/course");
    await page.locator("#videoq-transcript summary").click();
    await page.waitForFunction(() => document.querySelectorAll("#videoq-transcript-cues li").length === 1);
    expect(await page.locator("#videoq-transcript-cues").textContent()).toContain("<img src=x onerror=alert(1)>");
    expect(await page.locator("#videoq-transcript img").count()).toBe(0);
    await page.locator("#videoq-transcript-cues button").click();
    expect(await page.evaluate("window.seeks")).toEqual([{ videoId: 1, lesson: "first", seconds: 1 }]);
    await page.getByRole("button", { name: "Show more" }).click();
    await page.waitForFunction(() => document.querySelectorAll("#videoq-transcript-cues li").length === 2);
    await page.evaluate(() => {
      const source = document.querySelector("iframe")!.contentWindow;
      window.dispatchEvent(new MessageEvent("message", { source, origin: "https://attacker.example", data: {
        type: "videoq:ready", version: 1, channel: "f".repeat(32), videoId: 999, features: { transcripts: true },
      } }));
    });
    expect(await page.locator("#videoq-transcript-cues li").count()).toBe(2);
    expect(JSON.stringify(await page.evaluate("window.received"))).not.toContain("private-session-token");
    service.revoke();
    await page.getByRole("button", { name: "Refresh lessons" }).click();
    await page.waitForFunction(() => document.querySelector("#videoq-transcript-status")?.textContent === "Unable to load");
    expect(await page.locator("#videoq-transcript-cues li").count()).toBe(0);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
      source: document.querySelector("iframe")!.contentWindow, origin: "https://api.example",
      data: { type: "videoq:ready", version: 1, channel: "e".repeat(32), videoId: 1 },
    })));
    expect(await page.locator("#videoq-transcript").isHidden()).toBe(true);
    await page.close();
  });
});
