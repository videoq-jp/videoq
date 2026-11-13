import { mapVideoListRow } from "../../repositories/video-mapping";
import { INVALID_COLOR_MESSAGE, EMPTY_NAME_MESSAGE, normalizeTagName, isValidTagColor } from "../../shared/tag-policy";
import type { TagListItem,TagDetail,TagRepository } from "../contracts/tag-repository";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { type Db, withDb } from "../../db/pool";
import { tags, videos, videoTags } from "../../db/schema";
import { toUtcIso } from "../../shared/datetime";
import {
  videoTagsJson,
} from "./video-read-repository";
import type { Bindings } from "../../types/bindings";

// Tag 一覧 API のレスポンス表現。
// Must be "tags"."id": ${tags.id} becomes bare "id" → vt.id.
const videoCountSubquery = sql<number>`(SELECT count(*) FROM video_tags vt WHERE vt.tag_id = "tags"."id")::int`.as(
  "video_count",
);

const tagSelect = {
  id: tags.id,
  name: tags.name,
  color: tags.color,
  created_at: tags.createdAt,
};

const tagListSelect = { ...tagSelect, video_count: videoCountSubquery };

function mapTagListItem(row: TagListItem): TagListItem {
  return { ...row, id: Number(row.id), created_at: toUtcIso(row.created_at) };
}

/**
 * タグ一覧（ページ）。Tag.Meta.ordering=["name"] に従い name ASC。
 * video_count = Count("video_tags")（= video_tags の該当行数）。
 * count は総数、results は SQL の LIMIT/OFFSET で切ったページ。
 */
export async function listTagsPage(
  env: Bindings,
  userId: string,
  limit: number,
  offset: number,
): Promise<{ count: number; results: TagListItem[] }> {
  return withDb(env, async (db) => {
    const [countRow] = await db
      .select({ c: count() })
      .from(tags)
      .where(eq(tags.userId, userId));
    const total = Number(countRow.c);
    if (offset >= total) return { count: total, results: [] };

    const rows = await db
      .select(tagListSelect)
      .from(tags)
      .where(eq(tags.userId, userId))
      .orderBy(asc(tags.name))
      .limit(limit)
      .offset(offset);

    return { count: total, results: rows.map(mapTagListItem) };
  });
}

/**
 * タグ詳細。未所有または不在は null。
 * videos は該当 VideoTag の動画一覧表現を返し、安定した挿入順として vt.id ASC を用いる。
 */
async function readTagDetail(
  db: Db,
  tagId: number,
  userId: string,
) {
  const tagRows = await db
    .select(tagSelect)
    .from(tags)
    .where(and(eq(tags.id, tagId), eq(tags.userId, userId)))
    .limit(1);
  if (tagRows.length === 0) return null;

  const videoRows = await db
    .select({
      id: videos.id,
      file: videos.file,
      title: videos.title,
      description: videos.description,
      uploaded_at: videos.uploadedAt,
      status: videos.status,
      source_type: videos.sourceType,
      source_url: videos.sourceUrl,
      youtube_video_id: videos.youtubeVideoId,
      tags: videoTagsJson,
    })
    .from(videoTags)
    .innerJoin(videos, eq(videoTags.videoId, videos.id))
    .where(eq(videoTags.tagId, tagId))
    .orderBy(asc(videoTags.id));

  return { tag: tagRows[0], videoRows };
}

export async function getTagDetail(
  env: Bindings,
  tagId: number,
  userId: string,
): Promise<TagDetail | null> {
  const data = await withDb(env, (db) => readTagDetail(db, tagId, userId));
  if (!data) return null;
  const videos = await Promise.all(
    data.videoRows.map((r) => mapVideoListRow(env, r)),
  );

  return {
    ...mapTagListItem({ ...data.tag, video_count: videos.length }),
    videos,
  };
}

/**
 * 所有者条件付きのUPDATE RETURNINGで、更新と応答取得を1文で行う。
 * 更新APIはタグ情報だけを返すため、関連動画の取得とURL署名は不要。
 */
export async function updateTag(
  env: Bindings,
  tagId: number,
  userId: string,
  fields: { name?: string; color?: string },
): Promise<{ notFound: true } | { error: string } | { tag: TagListItem }> {
  const name = fields.name === undefined ? undefined : normalizeTagName(fields.name);
  const error = name === null ? EMPTY_NAME_MESSAGE
    : fields.color !== undefined && !isValidTagColor(fields.color) ? INVALID_COLOR_MESSAGE
      : null;
  const ownedTag = and(eq(tags.id, tagId), eq(tags.userId, userId));
  return withDb(env, async (db) => {
    if (error) {
      // Preserve notFound precedence without writing valid parts of an invalid patch.
      const [owner] = await db.select({ id: tags.id }).from(tags).where(ownedTag).limit(1);
      return owner ? { error } : { notFound: true } as const;
    }

    const rows = name !== undefined || fields.color !== undefined
      ? await db
        .update(tags)
        .set({ name: name ?? undefined, color: fields.color })
        .where(ownedTag)
        .returning(tagListSelect)
      : await db
        .select(tagListSelect)
        .from(tags)
        .where(ownedTag)
        .limit(1);
    return rows[0] ? { tag: mapTagListItem(rows[0]) } : { notFound: true } as const;
  });
}

/**
 * タグ作成。名前正規化・色検証は呼び出し側で済ませる。
 */
export async function createTag(
  env: Bindings,
  userId: string,
  name: string,
  color: string,
): Promise<TagListItem> {
  return withDb(env, async (db) => {
    const rows = await db
      .insert(tags)
      .values({
        userId,
        name,
        color,
        createdAt: sql`CURRENT_TIMESTAMP`,
      })
      .returning(tagSelect);
    return mapTagListItem({ ...rows[0], video_count: 0 });
  });
}

/** 所有タグを削除し、video_tags は FK の連鎖削除に任せる。 */
export async function deleteTag(
  env: Bindings,
  tagId: number,
  userId: string,
): Promise<{ notFound: true } | { ok: true }> {
  return withDb(env, async (db) => {
    const rows = await db
      .delete(tags)
      .where(and(eq(tags.id, tagId), eq(tags.userId, userId)))
      .returning({ id: tags.id });
    return rows.length > 0 ? { ok: true } as const : { notFound: true } as const;
  });
}

export function createPostgresTagRepository(env: Bindings): TagRepository {
 return {listPage: (userId,limit,offset)=>listTagsPage(env,userId,limit,offset),
 getDetail: (tagId,userId)=>getTagDetail(env,tagId,userId), update: (tagId,userId,fields)=>updateTag(env,tagId,userId,fields),
 create: (userId,name,color)=>createTag(env,userId,name,color),delete: (tagId,userId)=>deleteTag(env,tagId,userId)};
}
