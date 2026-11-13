import type { VideoDetail, VideoListItem, VideoListCriteria, VideoStatusCounts, StaleUploadingVideo } from "../persistence/contracts/video-read-repository";
export type { VideoDetail, VideoListItem, VideoListCriteria, VideoStatusCounts, StaleUploadingVideo } from "../persistence/contracts/video-read-repository";
export { mapVideoListRow, mapVideoDetailRow } from "./video-mapping";
import { createVideoMutationRepository, createVideoReadRepository, createVideoUploadRepository } from "../persistence/factory";
import type { OutboxedVideoJob, PendingVideoReservation, YoutubeVideoCreation } from "../persistence/contracts/video-upload-repository";
export type { OutboxedVideoJob, PendingVideoReservation } from "../persistence/contracts/video-upload-repository";
import type { CreationIdempotency } from "../persistence/contracts/creation-idempotency";
import type { VideoDeletionOptions } from "../persistence/contracts/video-mutation-repository";
import type { Bindings } from "../types/bindings";

/** VideoDetailView: id + user_id で1件取得（未所有/不在は null）。 */
export async function getVideoDetail(env: Bindings, videoId: number, userId: string, options: {includeFileUrl?: boolean} = {}): Promise<VideoDetail | null> {
 return (await createVideoReadRepository(env)).getDetail(videoId,userId,options);
}

/** Metadata-only reads do not transfer the transcript or resolve a media URL. */
export async function getVideoMetadata(env: Bindings, videoId: number, userId: string) {
 return (await createVideoReadRepository(env)).getMetadata(videoId,userId);
}

/**
 * 動画メタデータを更新する。タイトルのベクトルメタデータ同期と、
 * transcript再indexのoutbox作成と応答データの取得も同じtransactionに含める。
 */
export async function updateVideo(env: Bindings,videoId: number,userId: string,fields: {title?: string;description?: string;transcript?: string}) {
  return (await createVideoMutationRepository(env)).update(videoId,userId,fields);
}

/**
 * YouTube 動画レコードを作成する。
 * source_type='youtube', status='pending', file=''。作成した id を返す。
 */
export async function createYoutubeVideo(env: Bindings, userId: string, params: { sourceUrl: string; youtubeVideoId: string; title: string; description: string }, idempotency?: CreationIdempotency): Promise<YoutubeVideoCreation> {
 return (await createVideoUploadRepository(env)).createYoutube({userId, ...params, idempotency});
}

/** 確定前の状態と保存先を取得（未所有/不在は found:false）。 */
export async function getVideoUploadState(env: Bindings, videoId: number, userId: string) {
 return (await createVideoUploadRepository(env)).getUploadState(videoId, userId);
}

/**
 * 所有者・確認済み保存先が一致する uploading 動画だけを pending に進める。
 * 文字起こしジョブの保存も同じtransactionに含め、競合時はfalseを返す。
 */
export async function confirmUploadedVideo(env: Bindings, videoId: number, userId: string, fileKey: string): Promise<false | OutboxedVideoJob> {
 return (await createVideoUploadRepository(env)).confirmUpload({videoId, userId, fileKey});
}

/** status=uploading のまま放置された動画（FR-Q3 放棄解放用）。 */

/**
 * 署名 URL 期限（1h）を超えても uploading のままの行を取得。
 * `olderThanHours` 未満は対象外。バッチ上限で cron 実行時間を抑える。
 */
export async function listStaleUploadingVideos(env: Bindings, olderThanHours: number, limit=100): Promise<StaleUploadingVideo[]> {
 return (await createVideoReadRepository(env)).listStaleUploads(olderThanHours,limit);
}

/**
 * アップロード保留の動画レコードを作成する。
 * status='uploading'、source_type は既定 'uploaded'、uploaded_at=CURRENT_TIMESTAMP。
 * 作成した id を返す。
 */
export async function reserveAndCreatePendingVideo(env: Bindings, userId: string, storageBytes: number, fileKey: string, title: string, description: string, idempotency?: CreationIdempotency, transcriptionLanguage?: string): Promise<PendingVideoReservation> {
 return (await createVideoUploadRepository(env)).reserveUpload({userId, storageBytes, fileKey, title, description, idempotency, transcriptionLanguage});
}

/** 削除前に file_key と存在を取得（file 空文字/NULL は null）。 */
export async function getVideoFileKey(env: Bindings, videoId: number, userId: string) {
 const state = await (await createVideoUploadRepository(env)).getUploadState(videoId, userId);
 return state.found ? {found: true as const, fileKey: state.fileKey} : {found: false as const};
}

/**
 * 所有権をロック下で確認し、関連行のFK cascadeと配送taskの保存を含めて削除する。
 * FKを持たないベクトルと冪等性レコードは明示的に削除する。
 * expectedStatus 指定時は、ロック取得時にもその状態である場合だけ削除する。
 * expectedFileKey 指定時は、検証・転送した保存先が変わっていれば削除しない。
 */
export async function deleteVideoCascade(env: Bindings,videoId: number,userId: string,options: VideoDeletionOptions = {}) {
  return (await createVideoMutationRepository(env)).delete(videoId,userId,options);
}

/** ユーザー所有動画の status 別件数（ページングしない全件）。 */
export async function countVideosByStatus(env: Bindings,userId: string): Promise<VideoStatusCounts> {
 return (await createVideoReadRepository(env)).countByStatus(userId);
}

export async function listVideosPage(env: Bindings,userId: string,criteria: VideoListCriteria,limit: number,offset: number,options: {includeFileUrls?: boolean}={}): Promise<{count: number;results: VideoListItem[]}> {
 return (await createVideoReadRepository(env)).listPage(userId,criteria,limit,offset,options);
}
