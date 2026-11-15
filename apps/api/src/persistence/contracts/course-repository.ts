import type {VideoListItem} from './video-read-repository';
import type {CreationIdempotency} from './creation-idempotency';
/** VideoCourse 一覧 API のレスポンス表現。 */
export type CourseListItem = {
  id: number;
  name: string;
  description: string;
  display_order: number;
  created_at: string;
  video_count: number;
  access_role: "owner" | "member";
};

/**
 * ユーザーの講座一覧（ページ）+ 総数を単一接続で取得。
 * 並び: display_order ASC, created_at DESC, id ASC。
 * video_count は所属する動画の件数。
 */
// VideoCourseDetailSerializer: 一覧 + updated_at / share_slug / videos（ネスト）
export type CourseDetail = {
  id: number;
  name: string;
  description: string;
  display_order: number;
  created_at: string;
  updated_at: string;
  video_count: number;
  share_slug: string | null;
  videos: (VideoListItem & { order: number })[];
  access_role: "owner" | "member" | "public";
};

export type CourseInfo = Pick<CourseDetail, "name" | "description" | "video_count"> & {
  videos: Pick<CourseDetail["videos"][number], "id" | "title" | "description" | "status" | "order">[];
};

export type CourseReadOptions = {
  includeFileUrls?: boolean;
  /** Web の講座レスポンスはタグを含めない。MCP は既定の集計を使う。 */
  includeTags?: boolean;
  videoLimit?: number;
  videoOffset?: number;
};


export type CourseInfoOptions={videoLimit:number;videoOffset:number;courseDescriptionLimit:number;videoDescriptionLimit:number};
export interface CourseRepository {
  getInfo(courseId:number,ownerUserId:string,options:CourseInfoOptions):Promise<CourseInfo|null>;
  getDetail(courseId:number,userId:string,options?:CourseReadOptions):Promise<CourseDetail|null>;
  getShared(shareSlug:string,options?:CourseReadOptions):Promise<CourseDetail|null>;
  create(userId:string,name:string,description:string,idempotency?:CreationIdempotency):Promise<{ok:true;courseId:number;reused:boolean}|{idempotencyConflict:true}>;
  update(courseId:number,userId:string,fields:{name?:string;description?:string}):Promise<{notFound:true}|{course:CourseDetail}>;
  delete(courseId:number,userId:string):Promise<{notFound:true}|{ok:true}>;
  reorder(userId:string,courseIds:number[]):Promise<{mismatch:true}|{ok:true}>;
  ownedBy(courseId:number,userId:string):Promise<boolean>;
  setShareSlug(courseId:number,userId:string,slug:string):Promise<{conflict:true}|{notFound:true}|{ok:true}>;
  clearShareSlug(courseId:number,userId:string):Promise<{notFound:true}|{notConfigured:true}|{ok:true}>;
  listPage(userId:string,limit:number,offset:number):Promise<{count:number;results:CourseListItem[]}>;
}
