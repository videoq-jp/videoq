import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import type { QaQuestion, QaReply } from "@videoq/trpc";
import { questionView, scriptJson } from "../src/features/lti/view";

const browserTests = process.env.LTI_BROWSER_TESTS === "1" ? describe : describe.skip;
browserTests("LTI course Q&A", () => {
  let browser: Browser;
  const state = "a".repeat(64);
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.LTI_CHROMIUM_EXECUTABLE_PATH }); });
  afterAll(async () => { await browser?.close(); });
  async function fixture(page: Page, seedCount = 1) {
    const requests: Record<string, unknown>[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    let permissions = { viewTranscript: true, viewQa: true, postQa: true, voteQa: true, deleteOwnQa: true, moderateQa: false, instructorQa: false };
    const videos = [{ videoId: 1, lesson: "first", title: "Lesson One" }, { videoId: 2, lesson: "second", title: "Lesson Two" }];
    type SavedQuestion = QaQuestion & { own: boolean };
    const questions: SavedQuestion[] = Array.from({ length: seedCount }, (_, index) => ({
      id: crypto.randomUUID(), title: "Seed question " + index, body: "A published question", videoId: 1, videoTitle: "Lesson One",
      author: { name: "bbbbbbbb", source: "moodle", instructor: false }, createdAt: "2026-11-06T00:00:00Z", updatedAt: "2026-11-06T00:00:00Z",
      featured: false, replyCount: 0, votes: 0, voted: false, canEdit: false, canDelete: false, own: false,
    }));
    const replies = new Map<string, QaReply[]>();
    const expose = ({ own, ...question }: SavedQuestion): QaQuestion => ({ ...question, canEdit: own && permissions.postQa,
      canDelete: own && permissions.deleteOwnQa || permissions.moderateQa });
    await page.addInitScript(({ state }) => {
      if (location.origin === "https://api.example") sessionStorage.setItem("videoq-lti:" + state, "browser-secret");
    }, { state });
    await page.route("https://api.example/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/lti/launch") {
        await route.fulfill({ contentType: "text/html", body: questionView("nonce", state, "signed-token", "en", ["https://lms.example"]) }); return;
      }
      if (path === "/api/lti/session") {
        await route.fulfill({ json: { token: "private-session-token", features: { transcripts: true, qa: true },
          playback: { videoId: 1, parentOrigins: ["https://lms.example"], videos } } }); return;
      }
      expect(route.request().headers().authorization).toBe("Bearer private-session-token");
      if (path === "/api/lti/history") { await route.fulfill({ json: { turns: [] } }); return; }
      if (path === "/api/lti/materials") { await route.fulfill({ json: { permissions, videos } }); return; }
      if (path !== "/api/lti/qa") throw new Error("Unexpected API request: " + path);
      const input = route.request().postDataJSON() as Record<string, unknown>;
      requests.push(input);
      if (!permissions.viewQa) { await route.fulfill({ status: 403, json: { error: "denied" } }); return; }
      let data: unknown;
      const abilities = { canPost: permissions.postQa, canVote: permissions.voteQa, canModerate: permissions.moderateQa };
      const question = questions.find(question => question.id === input.questionId);
      if (input.action === "list") {
        const search = typeof input.search === "string" ? input.search : "";
        const found = questions.filter(question => (!search || question.title.toLowerCase().includes(search.toLowerCase()))
          && (!input.videoId || question.videoId === input.videoId) && (!input.unanswered || question.replyCount === 0));
        if (input.sort === "votes") found.sort((a, b) => b.votes - a.votes);
        const offset = Number(input.offset ?? 0), limit = Number(input.limit ?? 20);
        data = { items: found.slice(offset, offset + limit).map(expose), total: found.length, ...abilities };
      } else if (input.action === "ask") {
        const id = crypto.randomUUID();
        questions.unshift({ id, title: String(input.title), body: String(input.body), videoId: input.videoId as number | null,
          videoTitle: videos.find(video => video.videoId === input.videoId)?.title ?? null,
          author: { name: "aaaaaaaa", source: "moodle", instructor: permissions.instructorQa },
          createdAt: "2026-11-06T00:00:00Z", updatedAt: "2026-11-06T00:00:00Z", featured: false, replyCount: 0, votes: 0, voted: false,
          canEdit: true, canDelete: true, own: true });
        data = { id };
      } else {
        if (!question) { await route.fulfill({ status: 404, json: { error: "not found" } }); return; }
        const threadReplies = replies.get(question.id) ?? [];
        if (input.action === "get") data = { question: expose(question), replies: threadReplies.slice(Number(input.offset ?? 0), Number(input.offset ?? 0) + Number(input.limit ?? 20)), replyTotal: threadReplies.length, ...abilities };
        else if (input.action === "reply") {
          const id = crypto.randomUUID();
          threadReplies.push({ id, body: String(input.body), author: { name: "aaaaaaaa", source: "moodle", instructor: permissions.instructorQa },
            createdAt: "2026-11-06T00:00:00Z", updatedAt: "2026-11-06T00:00:00Z", canEdit: true, canDelete: true });
          replies.set(question.id, threadReplies); question.replyCount = threadReplies.length; data = { id };
        } else {
          if (input.action === "updateQuestion") { question.title = String(input.title); question.body = String(input.body); }
          if (input.action === "updateReply") threadReplies.find(reply => reply.id === input.replyId)!.body = String(input.body);
          if (input.action === "deleteReply") { replies.set(question.id, threadReplies.filter(reply => reply.id !== input.replyId)); question.replyCount = replies.get(question.id)!.length; }
          if (input.action === "deleteQuestion") questions.splice(questions.indexOf(question), 1);
          if (input.action === "feature") question.featured = Boolean(input.featured);
          if (input.action === "vote") { question.voted = Boolean(input.voted); question.votes = question.voted ? 1 : 0; }
          data = { success: true };
        }
      }
      await route.fulfill({ json: { data, permissions, videos } });
    });
    return { requests, errors, teacher: () => { permissions = { ...permissions, moderateQa: true, instructorQa: true }; },
      revoke: () => { permissions = { ...permissions, viewQa: false }; } };
  }
  it("pages, posts, edits, replies, votes, filters and deletes with literal text rendering", async () => {
    const page = await browser.newPage();
    const service = await fixture(page, 21);
    await page.goto("https://api.example/api/lti/launch");
    await page.locator("#course-qa summary").click();
    await page.waitForFunction(() => document.querySelectorAll("#qa-content article").length === 20);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("#qa-content article").length === 1);
    await page.getByRole("button", { name: "Ask the course", exact: true }).click();
    await page.getByLabel("Question title", { exact: true }).fill("My <img src=x> question");
    await page.getByLabel("Question details", { exact: true }).fill("<script>alert(1)</script> Course publication");
    await page.locator("#course-qa").getByLabel("Lesson", { exact: true }).selectOption("2");
    await page.getByRole("button", { name: "Publish question", exact: true }).click();
    await page.getByRole("heading", { name: "My <img src=x> question", exact: true }).waitFor();
    expect(await page.locator("#qa-content script,#qa-content img").count()).toBe(0);
    expect(await page.locator("#qa-content").textContent()).toContain("<script>alert(1)</script>");
    await page.locator("#qa-content > .qa-row").getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Question title", { exact: true }).fill("Edited question");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("heading", { name: "Edited question", exact: true }).waitFor();
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    await page.getByLabel("Reply details", { exact: true }).fill("My reply");
    await page.getByRole("button", { name: "Post reply", exact: true }).click();
    await page.locator("#qa-content article").filter({ hasText: "My reply" }).waitFor();
    await page.locator("#qa-content article").getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Reply details", { exact: true }).fill("Edited reply");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator("#qa-content article").filter({ hasText: "Edited reply" }).waitFor();
    await page.getByRole("button", { name: "Vote (0)", exact: true }).click();
    await page.getByRole("button", { name: "Remove vote (1)", exact: true }).waitFor();
    await page.getByRole("button", { name: "Back to questions", exact: true }).click();
    await page.getByLabel("Search questions", { exact: true }).fill("Edited question");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("#qa-content article").length === 1);
    await page.getByLabel("Unanswered questions", { exact: true }).check();
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByText("No questions yet.", { exact: true }).waitFor();
    await page.getByLabel("Unanswered questions", { exact: true }).uncheck();
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("button", { name: "Edited question", exact: true }).click();
    await page.locator("#qa-content article").getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await page.locator("#qa-content article").textContent()).toContain("Edited reply");
    await page.locator("#qa-content article").getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByText("No replies yet.", { exact: true }).waitFor();
    await page.locator("#qa-content > .qa-row").getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByText("No questions yet.", { exact: true }).waitFor();
    await page.setViewportSize({ width: 360, height: 720 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(service.requests.some(request => request.action === "ask" && request.videoId === 2)).toBe(true);
    expect(service.errors).toEqual([]);
    await page.close();
  }, 20000);

  it.skipIf(!process.env.LTI_MOODLE_PLUGIN_PATH)("joins after playback started, opens the actual Moodle panel, moderates, and revokes access", async () => {
    const plugin = process.env.LTI_MOODLE_PLUGIN_PATH!;
    const render = async (name: string, labels: Record<string, string>) => (await readFile(join(plugin, "templates", name + ".mustache"), "utf8"))
      .replace(/\{\{![\s\S]*?\}\}/g, "").replace(/\{\{(\w+)\}\}/g, (_, key) => labels[key] ?? "");
    const qa = await render("qa", { heading: "Course Q&A", unavailable: "Course Q&A is unavailable." });
    const transcript = await render("transcript", { heading: "Lesson transcripts", lesson: "Lesson", refresh: "Refresh lessons", more: "Show more", empty: "No transcript", error: "Unavailable", seek: "Jump to" });
    const [qaJs, transcriptJs, css] = await Promise.all(["qa.js", "transcript.js", "styles.css"].map(name => readFile(join(plugin, name), "utf8")));
    const page = await browser.newPage();
    const service = await fixture(page);
    await page.route("https://lms.example/**", route => route.fulfill({ contentType: "text/html", body: `<style>${css}.local-videoq-questions{height:650px}</style>
<div class="local-videoq-workspace" data-videoq-origin="https://api.example"><section class="local-videoq-questions">${qa}${transcript}<div id="videoq-native-chat">Native assistant</div><iframe class="local-videoq-transport" id="videoq-questions" title="Lesson assistant" aria-hidden="true" tabindex="-1" src="https://api.example/api/lti/launch"></iframe></section></div>
<script>${transcriptJs}</script><script>
window.events=[];window.currentReady=null;
function playback(){if(window.currentReady)document.querySelector('iframe').contentWindow.postMessage({type:'videoq:state',version:1,channel:window.currentReady.channel,videoId:1,seconds:1,duration:100},'https://api.example');}
window.addEventListener('message',event=>{if(event.origin!=='https://api.example')return;window.events.push(event.data);if(event.data.type==='videoq:ready'){window.currentReady=event.data;event.source.postMessage({type:'videoq:ui',version:1,renderer:'moodle',channel:event.data.channel,videoId:event.data.videoId},event.origin);playback();}});
setInterval(playback,150);setTimeout(()=>{const script=document.createElement('script');script.textContent=${scriptJson(qaJs)};document.body.append(script);},1200);
</script>` }));
    await page.goto("https://lms.example/course");
    await page.locator("#videoq-course-qa summary").click();
    const tool = page.frameLocator("#videoq-questions");
    await tool.getByRole("button", { name: "Seed question 0", exact: true }).click();
    await tool.getByRole("heading", { name: "Seed question 0", exact: true }).waitFor();
    expect(await tool.getByRole("button", { name: "Feature question", exact: true }).count()).toBe(0);
    expect(await tool.getByRole("button", { name: "Edit", exact: true }).count()).toBe(0);
    await tool.getByRole("button", { name: "Lesson One", exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { events: { type: string }[] }).events.some(event => event.type === "videoq:seek"));
    await page.locator("#videoq-course-qa summary").click();
    await page.locator("#videoq-native-chat").waitFor({ state: "visible" });
    expect(await page.locator("#videoq-native-chat").isVisible()).toBe(true);
    service.teacher();
    await page.locator("#videoq-course-qa summary").click();
    await tool.getByRole("button", { name: "Feature question", exact: true }).click();
    await tool.getByRole("button", { name: "Unfeature question", exact: true }).waitFor();
    const readyBefore = await page.evaluate<number>("window.events.filter(event=>event.type==='videoq:ready').length");
    await tool.locator("body").evaluate(() => {
      window.dispatchEvent(new MessageEvent("message", { source: window.parent, origin: "https://attacker.example", data: { type: "videoq:hello", version: 1 } }));
      window.dispatchEvent(new MessageEvent("message", { source: window, origin: "https://lms.example", data: { type: "videoq:hello", version: 1 } }));
    });
    await page.waitForTimeout(100);
    expect(await page.evaluate("window.events.filter(event=>event.type==='videoq:ready').length")).toBe(readyBefore);
    expect(JSON.stringify(await page.evaluate("window.events"))).not.toContain("private-session-token");
    expect(JSON.stringify(await page.evaluate("window.events"))).not.toContain("A published question");
    await page.locator("#videoq-course-qa summary").click();
    service.revoke();
    await page.locator("#videoq-course-qa summary").click();
    await page.getByText("Course Q&A is unavailable.", { exact: true }).waitFor();
    expect(await page.locator(".local-videoq-qa-open").count()).toBe(0);
    expect(await page.locator("#videoq-native-chat").isVisible()).toBe(true);
    expect(service.errors).toEqual([]);
    await page.close();
  }, 20000);
});
