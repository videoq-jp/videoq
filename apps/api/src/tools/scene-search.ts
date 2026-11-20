import { z } from "zod";
import { defineTool } from "./definition";
import { createSceneSearchService } from "../features/evidence/scene-search-service";
import type { SceneSearch } from "../repositories/vector-repository";

export { MAX_SCENE_SEARCHES } from "./contract";
export function createSceneSearchTool(
  search: SceneSearch,
  videoIds: readonly number[],
) {
  const execute = createSceneSearchService(videoIds);
  return defineTool(
    (input, { signal, reportProgress }) => execute(input, {
      checkCancelled: () => signal.throwIfAborted(), reportProgress,
      search: (query, ids) => search.search(query, ids, signal),
    }),
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

