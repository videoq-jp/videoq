import type { SceneHit } from '../../persistence/contracts/scene-search';
import { transcriptQuality } from '@videoq/domain/transcript-quality';
import { EvidenceBudget } from '../../domain/conversation/evidence-budget';

export interface SceneSearchExecution {
  checkCancelled(): void;
  search(query: string, videoIds?: readonly number[]): Promise<SceneHit[]>;
  reportProgress?: (event: Record<string, unknown>) => Promise<void>;
}

/** このクエリの 0 件と講座全体の不在を区別する。空文字で検索を繰り返させない。 */
const NO_HITS = "No subtitle scenes matched this query. Subtitle search does not inspect images and does not establish absence from the course or any video. Use video viewing tools for on-screen text, objects or changes.";

/** 上限超過はツール結果として返す。エラーで打ち切ると回答本文が無いまま終わるため。 */
const SEARCH_LIMIT_REACHED =
  "Search limit reached: no more searches are available for this answer. " +
  "Answer using the evidence available, or explain what could not be verified. Never infer course-wide absence from limited searches.";

export function createSceneSearchService(videoIds: readonly number[]) {
  let used = 0;
  const budget = new EvidenceBudget();
  const allowedVideoIds = new Set(videoIds);
  return async ({ query, video_ids }: { query: string; video_ids: number[] | null }, deps: SceneSearchExecution) => {
    const { reportProgress } = deps;
    deps.checkCancelled();
    // 上限はツール側で数える。middleware で打ち切るとモデルが最終回答を
    // 生成する前にグラフが終わってしまう。

    if (!budget.hasCapacity('search')) return SEARCH_LIMIT_REACHED;
    if (video_ids?.some((id) => !allowedVideoIds.has(id))) {
      return "Invalid video_ids: only videos in the current course may be searched. " +
        "Use get_course_info to find valid IDs; this search was not executed.";
    }
    if (budget.reserveTool('search') === 'limit') return SEARCH_LIMIT_REACHED;
    const searchId = ++used;
    await reportProgress?.({ searching: query, searchId });
    const hits = await deps.search(query, video_ids ?? undefined);
    deps.checkCancelled();
    await reportProgress?.({ searchCompleted: { id: searchId, query, count: hits.length } });
    if (hits.length === 0) return NO_HITS;
    return { scenes: hits.map(hit => ({ videoId: hit.videoId, title: hit.videoTitle, startTime: hit.startTime, endTime: hit.endTime, text: hit.content, ...(hit.evidenceType ? { evidenceType: hit.evidenceType } : {}), transcript_quality: transcriptQuality(hit) })) };
  };
}
