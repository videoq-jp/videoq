import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { parse } from "dotenv";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import {
  deleteR2Object, getR2ObjectSize, presignR2Put, readMediaBytes,
  readMediaRange, resolveFileUrl,
  createR2MultipartUpload, presignR2UploadPart, completeR2MultipartUpload, abortR2MultipartUpload,
} from "../src/integrations/media";

// Explicitly opt in: this creates and deletes isolated objects in local Garage.
describe.skipIf(process.env.GARAGE_INTEGRATION !== "1")("local Garage storage", () => {
  function localConfig() {
    let local: Record<string, string> = {};
    try { local = parse(readFileSync(new URL("../../../.env", import.meta.url))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const value = (name: string, fallback: string) => process.env[name] || local[name] || fallback;
    const endpoint = `http://127.0.0.1:${value("GARAGE_S3_PORT", "9000")}`;
    return {
      ENVIRONMENT: "development",
      USE_S3_STORAGE: "true",
      R2_ACCESS_KEY_ID: value("GARAGE_ACCESS_KEY_ID", "GK00000000000000000000000000000000"),
      R2_SECRET_ACCESS_KEY: value("GARAGE_SECRET_ACCESS_KEY", "0".repeat(64)),
      R2_BUCKET_NAME: value("GARAGE_BUCKET", "videoq-media"),
      R2_S3_ENDPOINT: endpoint,
      R2_S3_INTERNAL_ENDPOINT: endpoint,
      R2_S3_REGION: "garage",
    } as never;
  }

  it("supports signed uploads, private reads, CORS, HEAD, ranges, ETags, and deletion", async () => {
    const env = localConfig();
    const key = `garage-smoke/${crypto.randomUUID()}/日本語 + 'clip.webm`;
    const fixture = readFileSync(new URL("../../web/.storybook/fixtures/media/preview.webm", import.meta.url));
    try {
      expect(await getR2ObjectSize(env, key)).toBeNull();
      const put = await presignR2Put(env, key, "video/webm", fixture.length);
      for (const origin of ["http://localhost", "http://127.0.0.1", "http://localhost:3000", "http://127.0.0.1:3000"]) {
        for (const method of ["PUT", "GET", "HEAD"]) {
          const preflight = await fetch(put, { method: "OPTIONS", headers: {
            Origin: origin, "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "content-type,range,if-match",
          } });
          expect(preflight.ok).toBe(true);
          expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
          await preflight.body?.cancel();
        }
      }
      const denied = await fetch(put, { method: "OPTIONS", headers: {
        Origin: "https://untrusted.example", "Access-Control-Request-Method": "PUT",
      } });
      // Garage also puts CORS headers on errors; a rejected preflight must fail.
      expect(denied.ok).toBe(false);
      await denied.body?.cancel();

      const wrongType = await fetch(put, { method: "PUT", body: fixture,
        headers: { "Content-Type": "application/octet-stream" } });
      expect(wrongType.status).toBe(403);
      await wrongType.body?.cancel();
      const uploaded = await fetch(put, { method: "PUT", body: fixture,
        headers: { "Content-Type": "video/webm" } });
      expect(uploaded.ok).toBe(true);
      await uploaded.body?.cancel();
      expect(await getR2ObjectSize(env, key)).toBe(fixture.length);
      expect(Buffer.from((await readMediaBytes(env, key, fixture.length))!)).toEqual(fixture);
      const range = await readMediaRange(env, key, 7, 37);
      expect(range?.size).toBe(fixture.length);
      expect(Buffer.from(range!.bytes)).toEqual(fixture.subarray(7, 44));
      expect(await readMediaRange(env, key, 44, 20, undefined, range!.etag)).not.toBeNull();
      expect(await readMediaRange(env, key, 0, 10, undefined, '"stale-etag"')).toBeNull();

      const get = (await resolveFileUrl(env, key))!;
      const downloaded = await fetch(get);
      expect(downloaded.ok).toBe(true);
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(fixture);
      const unsigned = await fetch(get.split("?")[0]);
      expect(unsigned.status).toBe(403);
      await unsigned.body?.cancel();
    } finally {
      await deleteR2Object(env, key);
    }
    expect(await getR2ObjectSize(env, key)).toBeNull();
    expect(await readMediaBytes(env, key, 100)).toBeNull();
  }, 30_000);

  it("uploads from Chromium and plays/seeks the stored video across origins", async () => {
    const env = localConfig();
    const key = `garage-smoke/${crypto.randomUUID()}/browser.webm`;
    const fixture = readFileSync(new URL("../../web/.storybook/fixtures/media/preview.webm", import.meta.url));
    const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
    try {
      const page = await browser.newPage();
      page.on("console", message => {
        if (message.type() === "error") console.error(message.text().replace(/\?[^\s'"<>]*/g, "?[redacted]"));
      });
      // Load the real local origin so Chromium applies its normal network policy.
      await page.goto("http://localhost");
      await page.setContent('<!doctype html><video controls muted></video>');
      const put = await presignR2Put(env, key, "video/webm", fixture.length);
      const result = await page.evaluate(async ({ url, bytes }) => {
        const response = await fetch(url, { method: "PUT",
          body: new Blob([new Uint8Array(bytes)], { type: "video/webm" }) });
        return { status: response.status, etag: response.headers.get("etag") };
      }, { url: put, bytes: [...fixture] });
      expect(result.status).toBe(200);
      expect(result.etag).toBeTruthy();
      const get = (await resolveFileUrl(env, key))!;
      await page.evaluate(url => {
        const video = document.querySelector("video")!;
        video.crossOrigin = "anonymous";
        video.src = url;
      }, get);
      await page.waitForFunction(() => document.querySelector("video")!.readyState >= 2);
      const playback = await page.evaluate(async () => {
        const video = document.querySelector("video")!;
        await video.play();
        const playing = !video.paused;
        video.pause();
        const seeked = new Promise<void>(resolve => video.addEventListener("seeked", () => resolve(), { once: true }));
        video.currentTime = 1;
        await seeked;
        return { playing, duration: video.duration, position: video.currentTime, error: video.error?.code };
      });
      expect(playback.playing).toBe(true);
      expect(playback.duration).toBeCloseTo(2, 1);
      expect(playback.position).toBeCloseTo(1, 1);
      expect(playback.error).toBeUndefined();
    } finally {
      await browser.close();
      await deleteR2Object(env, key);
    }
  }, 30_000);

  it("uploads multipart from Chrome with signed lengths and exposed ETags", async () => {
    const env = localConfig();
    const key = `garage-smoke/${crypto.randomUUID()}/multipart.mkv`;
    const type = "video/matroska";
    const partSize = 5 * 1024 * 1024;
    const lengths = [partSize, partSize, 17];
    const uploadId = await createR2MultipartUpload(env, key, type);
    const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
    try {
      const urls = await Promise.all(lengths.map((length, index) => presignR2UploadPart(env, key, uploadId, index + 1, type, length)));
      const wrongLength = await fetch(urls[2], { method: "PUT", headers: { "Content-Type": type }, body: new Uint8Array(18) });
      expect(wrongLength.status).toBe(403);
      await wrongLength.body?.cancel();
      const page = await browser.newPage();
      await page.goto("http://localhost");
      const parts = await page.evaluate(async ({ urls, lengths, type }) => Promise.all(urls.map((url, index) =>
        new Promise<{ partNumber: number; etag: string }>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", url);
          xhr.setRequestHeader("Content-Type", type);
          xhr.addEventListener("load", () => {
            const etag = xhr.getResponseHeader("ETag")?.replace(/^"|"$/g, "");
            if (xhr.status !== 200 || !etag) reject(new Error(`Part upload failed: ${xhr.status}`));
            else resolve({ partNumber: index + 1, etag });
          });
          xhr.addEventListener("error", () => reject(new Error("Part upload network error")));
          xhr.send(new Blob([new Uint8Array(lengths[index]).fill(index + 1)], { type }));
        }),
      )), { urls, lengths, type });
      expect(await getR2ObjectSize(env, key)).toBeNull();
      await completeR2MultipartUpload(env, key, uploadId, parts);
      expect(await getR2ObjectSize(env, key)).toBe(2 * partSize + 17);
      const boundary = await readMediaRange(env, key, partSize - 2, 4);
      expect([...boundary!.bytes]).toEqual([1, 1, 2, 2]);
    } finally {
      await browser.close();
      await abortR2MultipartUpload(env, key, uploadId);
      await abortR2MultipartUpload(env, key, uploadId);
      await deleteR2Object(env, key);
    }
  }, 60_000);
});
