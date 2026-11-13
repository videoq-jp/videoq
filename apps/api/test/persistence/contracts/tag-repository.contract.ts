import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TAG_COLORS } from "@videoq/trpc";
import type { TagRepository } from "../../../src/persistence/contracts/tag-repository";

export interface TagFixture {
  repository: TagRepository;
  linkVideo(tagId: number): Promise<number>;
  linkCount(tagId: number): Promise<number>;
  dispose(): Promise<void>;
}
export function tagRepositoryContract(backend: string, createFixture: () => Promise<TagFixture>) {
  describe(`${backend}: tag contract`, () => {
    let fixture: TagFixture | undefined;
    beforeEach(async () => { fixture = await createFixture(); }, 20_000);
    afterEach(async () => { await fixture?.dispose(); fixture = undefined; });
    const current = () => { if (!fixture) throw new Error("Tag fixture not initialized"); return fixture; };
    it("normalizes updates and preserves ownership before validation errors", async () => {
      const repo = current().repository;
      const tag = await repo.create("owner", "Tag", TAG_COLORS[0]);
      expect(tag).toMatchObject({ name: "Tag", color: TAG_COLORS[0], video_count: 0 });
      expect(new Date(tag.created_at).toISOString()).toBe(tag.created_at);
      expect(await repo.getDetail(tag.id, "other")).toBeNull();
      expect(await repo.update(tag.id, "other", { name: " " })).toEqual({ notFound: true });
      expect(await repo.update(tag.id, "owner", { name: " " })).toHaveProperty("error");
      expect(await repo.update(tag.id, "owner", { name: "Bad partial update", color: "invalid-color" })).toHaveProperty("error");
      expect((await repo.getDetail(tag.id, "owner"))?.name).toBe("Tag");
      expect(await repo.update(tag.id, "owner", { name: "  Renamed  ", color: TAG_COLORS[1] })).toMatchObject({ tag: { name: "Renamed", color: TAG_COLORS[1] } });
      expect(await repo.update(tag.id, "owner", {})).toMatchObject({ tag: { name: "Renamed" } });
    });
    it("paginates owned tags and includes related videos with accurate counts", async () => {
      const f = current();
      const zeta = await f.repository.create("owner", "Zeta", TAG_COLORS[0]);
      await f.repository.create("owner", "Alpha", TAG_COLORS[0]);
      await f.repository.create("other", "Hidden", TAG_COLORS[0]);
      const videoId = await f.linkVideo(zeta.id);
      const first = await f.repository.listPage("owner", 1, 0);
      expect(first).toMatchObject({ count: 2, results: [{ name: "Alpha", video_count: 0 }] });
      expect(await f.repository.listPage("owner", 1, 10)).toEqual({ count: 2, results: [] });
      expect(await f.repository.getDetail(zeta.id, "owner")).toMatchObject({ video_count: 1, videos: [{ id: videoId, title: "Related", file: "/api/media/related.mp4" }] });
    });
    it("deletes owned tags with cascading links", async () => {
      const f = current(); const tag = await f.repository.create("owner", "Tag", TAG_COLORS[0]);
      await f.linkVideo(tag.id);
      expect(await f.repository.delete(tag.id, "other")).toEqual({ notFound: true });
      expect(await f.linkCount(tag.id)).toBe(1);
      expect(await f.repository.delete(tag.id, "owner")).toEqual({ ok: true });
      expect(await f.linkCount(tag.id)).toBe(0);
      expect(await f.repository.delete(tag.id, "owner")).toEqual({ notFound: true });
    });
  });
}
