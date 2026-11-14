import type { VideoListItem } from "./video-read-repository";

export type TagListItem = {
  id: number;
  name: string;
  color: string;
  created_at: string;
  video_count: number;
};

// Tag 詳細 API のレスポンス表現（TagList + ネスト videos）。
export type TagDetail = TagListItem & {
  videos: VideoListItem[];
};


export interface TagRepository {
 listPage(userId: string,limit: number,offset: number): Promise<{count: number;results: TagListItem[]}>;
 getDetail(tagId: number,userId: string): Promise<TagDetail|null>;
 update(tagId: number,userId: string,fields: {name?: string;color?: string}): Promise<{notFound: true}|{error: string}|{tag: TagListItem}>;
 create(userId: string,name: string,color: string): Promise<TagListItem>;
 delete(tagId: number,userId: string): Promise<{notFound: true}|{ok: true}>;
}

/** Both dialects normalize only the per-owner tag-name unique constraint. */
export class TagNameConflictError extends Error {
  constructor() { super("A tag with this name already exists."); this.name = "TagNameConflictError"; }
}
