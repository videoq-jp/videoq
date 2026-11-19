import { z } from "zod";
import { defineTool } from "./definition";
import { transcriptQuality } from "../lib/transcript-quality";
import type { SceneSearch } from "../repositories/vector-repository";

import { MAX_SCENE_SEARCHES } from "./contract";
export { MAX_SCENE_SEARCHES } from "./contract";
/** ヒット 0 件でも「検索したが無かった」と伝える。空文字だとモデルが再検索を繰り返す。 */
const NO_HITS = "No subtitle scenes matched this query. Subtitle search does not inspect images and cannot establish that visible content is absent. Use video viewing tools for on-screen text, objects or changes.";

/** 上限超過はツール結果として返す。エラーで打ち切ると回答本文が無いまま終わるため。 */
const SEARCH_LIMIT_REACHED =
  "Search limit reached: no more searches are available for this answer. " +
  "Answer now using the scenes you already have, or state that the question is " +
  "outside the scope of the video materials.";

export function createSceneSearchTool(
  search: SceneSearch,
  videoIds: readonly number[],
) {
  let used = 0;
  const allowedVideoIds = new Set(videoIds);
  return defineTool(
    async ({ query, video_ids }, { signal, reportProgress }) => {
      signal.throwIfAborted();
      // 上限はツール側で数える。middleware で打ち切るとモデルが最終回答を
      // 生成する前にグラフが終わってしまう。
      if (used >= MAX_SCENE_SEARCHES) return SEARCH_LIMIT_REACHED;
      if (video_ids?.some((id) => !allowedVideoIds.has(id))) {
        return "Invalid video_ids: only videos in the current course may be searched. " +
          "Use get_course_info to find valid IDs; this search was not executed.";
      }
      const searchId = ++used;
      await reportProgress?.({ searching: query, searchId });
      const hits = await search.search(query, video_ids ?? undefined, signal);
      signal.throwIfAborted();
      await reportProgress?.({ searchCompleted: { id: searchId, query, count: hits.length } });
      if (hits.length === 0) return NO_HITS;
      return { scenes: hits.map(hit => ({ videoId: hit.videoId, title: hit.videoTitle, startTime: hit.startTime, endTime: hit.endTime, text: hit.content, ...(hit.evidenceType ? { evidenceType: hit.evidenceType } : {}), transcript_quality: transcriptQuality(hit) })) };
    },
    {
      name: "search_scenes",
      description:
        "Search spoken subtitles of the user's video course by meaning, not images, and return the closest excerpts. " +
        "The default way to ground definitions, explanations, comparisons, examples and calculations, " +
        "including short terms and questions that do not explicitly mention the course. " +
        "For highlights, first identify the video's genre; visual highlights need viewing tools and candidate before/after evidence, not only matching subtitles. " +
        "For broad video navigation or visual topics without subtitle clues, overview_video/skim_video can retrieve evidence instead. " +
        "For course-wide content, call directly with video_ids set to null. For a specific video or lecture, " +
        "first identify it with get_course_info and include its ID in video_ids on every search. " +
        "Pass a natural-language query describing what you need; it does not have to be the " +
        "user's question verbatim. Optionally select video_ids from get_course_info; using " +
        "null searches the whole current course. Each scene includes video identity, timestamps and evidence text.",
      schema: z.object({
        query: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .describe("What to look for, in the same language as the course material."),
        video_ids: z.array(z.number().int().positive().safe()).min(1).max(50).nullable()
          .describe("IDs of videos in the current course to search; null for the whole course."),
      }).strict(),
    },
  );
}

