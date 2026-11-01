import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mediaRoutes } from "../src/features/media/routes";
import * as auth from "../src/middleware/auth";
import { THROTTLE_RATES } from "../src/lib/rate-limit";
import type { Bindings } from "../src/types/bindings";

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;

(databaseUrl ? describe : describe.skip)("media authorization on PostgreSQL", () => {
  const schema = `media_access_${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let env: Bindings;
  const getObject = vi.fn();

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`
      CREATE SCHEMA "${schema}";
      SET search_path TO "${schema}";
      CREATE TABLE videos (id bigint PRIMARY KEY, user_id text NOT NULL, file text NOT NULL);
      CREATE TABLE video_courses (id bigint PRIMARY KEY, share_slug text UNIQUE);
      CREATE TABLE video_course_members (video_id bigint REFERENCES videos, course_id bigint REFERENCES video_courses);
      CREATE TABLE video_course_memberships (user_id text, course_id bigint REFERENCES video_courses);
    `);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    env = {
      ENVIRONMENT: "development", HYPERDRIVE: { connectionString: url.toString() },
      VIDEO_BUCKET: { get: getObject },
    } as unknown as Bindings;
  });
  beforeEach(async () => {
    await admin.query(`
      TRUNCATE videos, video_courses, video_course_members, video_course_memberships;
      INSERT INTO videos VALUES (1, 'owner', 'videos/owned.mp4'), (2, 'other', 'videos/other.mp4');
      INSERT INTO video_courses VALUES (10, 'shared'), (20, 'other'), (30, 'empty'), (40, NULL);
      INSERT INTO video_course_members VALUES (1, 10), (2, 20), (2, 40);
      INSERT INTO video_course_memberships VALUES ('member', 10);
    `);
    // Only session parsing is stubbed; authorization uses the real database.
    vi.spyOn(auth, "sessionMethod").mockResolvedValue({ kind: "absent" });
    getObject.mockReset().mockImplementation(async () => ({
      body: new TextEncoder().encode("video"), size: 5, httpEtag: '"media-etag"',
      writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", "video/mp4"),
    }));
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });

  it.each(["share_slug", "share_token"])("streams shared media using one authorization connection and query via %s", async parameter => {
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    const query = vi.spyOn(pg.Client.prototype, "query");
    const response = await mediaRoutes.request(`/api/media/videos/owned.mp4?${parameter}=shared`, {}, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("video");
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=0");
    expect(getObject).toHaveBeenCalledExactlyOnceWith("media/videos/owned.mp4", undefined);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    { path: "videos/other.mp4", slug: "shared", status: 404 },
    { path: "videos/owned.mp4", slug: "empty", status: 404 },
    { path: "videos/missing.mp4", slug: "shared", status: 404 },
    { path: "videos/owned.mp4", slug: "missing", status: 401 },
    { path: "videos//owned.mp4", slug: "shared", status: 404 },
    { path: "videos/%2e%2e%2fprivate.mp4", slug: "shared", status: 404 },
    { path: "videos/%5cprivate.mp4", slug: "shared", status: 404 },
    { path: "videos/%2e%2e%2fprivate.mp4", slug: "missing", status: 401 },
    { path: "videos/%ZZ.mp4", slug: "shared", status: 404 },
    { path: "videos/%ZZ.mp4", slug: "missing", status: 401 },
    { path: "videos/%00.mp4", slug: "shared", status: 404 },
    { path: "videos/%00.mp4", slug: "missing", status: 401 },
  ])("rejects $path through $slug with $status without reading storage", async ({ path, slug, status }) => {
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    const query = vi.spyOn(pg.Client.prototype, "query");
    const response = await mediaRoutes.request(`/${path}?share_slug=${slug}`, {}, env);
    expect(response.status).toBe(status);
    expect(getObject).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(["owner", "member"])("allows %s using the existing session permission in one query", async userId => {
    vi.mocked(auth.sessionMethod).mockResolvedValue({ kind: "ok", userId, via: "session" });
    const query = vi.spyOn(pg.Client.prototype, "query");
    const response = await mediaRoutes.request("/videos/owned.mp4", {}, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("video");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(["share_slug", "share_token"])("lets a signed-in non-member watch the shared course via %s", async parameter => {
    vi.mocked(auth.sessionMethod).mockResolvedValue({ kind: "ok", userId: "other", via: "session" });
    const query = vi.spyOn(pg.Client.prototype, "query");
    const response = await mediaRoutes.request(`/videos/owned.mp4?${parameter}=shared`, {}, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("video");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    { userId: "other", path: "other", slug: "shared", status: 404 },
    { userId: "owner", path: "owned", slug: "other", status: 404 },
    { userId: "owner", path: "owned", slug: "missing", status: 401 },
  ])("keeps an explicit share scoped even for $userId: $path/$slug", async ({ userId, path, slug, status }) => {
    vi.mocked(auth.sessionMethod).mockResolvedValue({ kind: "ok", userId, via: "session" });
    const response = await mediaRoutes.request(`/videos/${path}.mp4?share_slug=${slug}`, {}, env);
    expect(response.status).toBe(status);
    expect(getObject).not.toHaveBeenCalled();
  });

  it.each(["%ZZ", "%00", "%2e%2e%2fprivate"])("rejects a malformed signed-in media path before connecting: %s", async path => {
    vi.mocked(auth.sessionMethod).mockResolvedValue({ kind: "ok", userId: "owner", via: "session" });
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    const response = await mediaRoutes.request(`/videos/${path}.mp4`, {}, env);
    expect(response.status).toBe(404);
    expect(connect).not.toHaveBeenCalled();
    expect(getObject).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: { kind: "invalid", message: "Session rejected" } as const, status: 401 },
    { outcome: { kind: "forbidden", message: "Session rejected", requiredScope: "read" } as const, status: 403 },
  ])("does not fall back to sharing after a $status refusal", async ({ outcome, status }) => {
    vi.mocked(auth.sessionMethod).mockResolvedValue(outcome);
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    const response = await mediaRoutes.request("/videos/owned.mp4?share_slug=shared", {}, env);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { message: "Session rejected" } });
    expect(connect).not.toHaveBeenCalled();
    expect(getObject).not.toHaveBeenCalled();
  });

  it.each(["", "?share_slug=", "?share_token="])("rejects absent credentials without a query: %s", async queryString => {
    const query = vi.spyOn(pg.Client.prototype, "query");
    const response = await mediaRoutes.request(`/videos/owned.mp4${queryString}`, {}, env);
    expect(response.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
    expect(getObject).not.toHaveBeenCalled();
  });

  it("does not authorize a video added only after its share link was revoked", async () => {
    await admin.query("DELETE FROM video_course_members WHERE course_id = 10");
    const promiseClient = pg.Client.prototype as { end(this: pg.Client): Promise<void> };
    const originalEnd = promiseClient.end;
    let changed = false;
    vi.spyOn(promiseClient, "end").mockImplementation(async function (this: pg.Client) {
      await originalEnd.call(this);
      if (this !== admin && !changed) {
        changed = true;
        await admin.query(`
          BEGIN;
          UPDATE video_courses SET share_slug = NULL WHERE id = 10;
          INSERT INTO video_course_members VALUES (1, 10);
          COMMIT;
        `);
      }
    });
    const response = await mediaRoutes.request("/videos/owned.mp4?share_slug=shared", {}, env);
    expect(changed).toBe(true);
    expect(response.status).toBe(404);
    expect(getObject).not.toHaveBeenCalled();
    expect((await mediaRoutes.request("/videos/owned.mp4?share_slug=shared", {}, env)).status).toBe(401);
  });

  it.each([
    { range: { offset: 1, length: 3 }, header: "bytes=1-3", contentRange: "bytes 1-3/5", body: "ide" },
    { range: { offset: 2 }, header: "bytes=2-", contentRange: "bytes 2-4/5", body: "deo" },
    { range: { suffix: 3 }, header: "bytes=-3", contentRange: "bytes 2-4/5", body: "deo" },
    { range: { length: 3 }, header: "bytes=0-2", contentRange: "bytes 0-2/5", body: "vid" },
  ])("preserves Range streaming and metadata: $header", async ({ range, header, contentRange, body }) => {
    getObject.mockResolvedValue({
      body: new TextEncoder().encode(body), size: 5, range,
      httpEtag: '"media-etag"', writeHttpMetadata: () => {},
    });
    const response = await mediaRoutes.request("/videos/owned.mp4?share_slug=shared", { headers: { Range: header } }, env);
    expect(response.status).toBe(206);
    expect(await response.text()).toBe(body);
    expect(response.headers.get("Content-Range")).toBe(contentRange);
    expect(response.headers.get("Content-Length")).toBe("3");
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.get("ETag")).toBe('"media-etag"');
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(getObject.mock.calls[0][1].range.get("Range")).toBe(header);
  });

  it("throttles invalid slugs without charging valid shared requests", async () => {
    const request = (slug: string, path = "videos/owned.mp4") => mediaRoutes.request(
      `/${path}?share_slug=${slug}`, { headers: { "CF-Connecting-IP": "192.0.2.42" } }, env,
    );
    for (let i = 0; i < THROTTLE_RATES.share_slug_probe_ip.limit; i++) {
      expect((await request("missing")).status).toBe(401);
    }
    expect((await request("missing")).status).toBe(429);
    expect((await request("shared", "videos/other.mp4")).status).toBe(404);
    const valid = await request("shared");
    expect(valid.status).toBe(200);
    expect(await valid.text()).toBe("video");
  });
});
