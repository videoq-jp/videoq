import type { SceneHit } from '../../persistence/contracts/scene-search';
import { transcriptQuality } from '@videoq/domain/transcript-quality';
import { MAX_SCENE_SEARCHES } from '../../application/evidence';

export interface SceneSearchExecution {
  checkCancelled(): void;
  search(query: string, videoIds?: readonly number[]): Promise<SceneHit[]>;
  reportProgress?: (event: Record<string, unknown>) => Promise<void>;
}

/** ヒット 0 件でも「検索したが無かった」と伝える。空文字だとモデルが再検索を繰り返す。 */
const NO_HITS = "No subtitle scenes matched this query. Subtitle search does not inspect images and cannot establish that visible content is absent. Use video viewing tools for on-screen text, objects or changes.";

/** 上限超過はツール結果として返す。エラーで打ち切ると回答本文が無いまま終わるため。 */
const SEARCH_LIMIT_REACHED =
  "Search limit reached: no more searches are available for this answer. " +
  "Answer now using the scenes you already have, or state that the question is " +
  "outside the scope of the video materials.";

export function createSceneSearchService(videoIds: readonly number[]) {
  let used = 0;
  const allowedVideoIds = new Set(videoIds);
  return async ({ query, video_ids }: { query: string; video_ids: number[] | null }, deps: SceneSearchExecution) => {
    const { reportProgress } = deps;
    deps.checkCancelled();
    // 上限はツール側で数える。middleware で打ち切るとモデルが最終回答を
    // 生成する前にグラフが終わってしまう。
    if (used >= MAX_SCENE_SEARCHES) return SEARCH_LIMIT_REACHED;
    if (video_ids?.some((id) => !allowedVideoIds.has(id))) {
      return "Invalid video_ids: only videos in the current course may be searched. " +
        "Use get_course_info to find valid IDs; this search was not executed.";
    }
    const searchId = ++used;
    await reportProgress?.({ searching: query, searchId });
    const hits = await deps.search(query, video_ids ?? undefined);
    deps.checkCancelled();
    await reportProgress?.({ searchCompleted: { id: searchId, query, count: hits.length } });
    if (hits.length === 0) return NO_HITS;
    return { scenes: hits.map(hit => ({ videoId: hit.videoId, title: hit.videoTitle, startTime: hit.startTime, endTime: hit.endTime, text: hit.content, ...(hit.evidenceType ? { evidenceType: hit.evidenceType } : {}), transcript_quality: transcriptQuality(hit) })) };
  };
}
