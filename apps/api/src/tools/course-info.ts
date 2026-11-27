import { defineTool } from "./definition";
import { z } from "zod";
import { getCourseInfo } from "../repositories/course-repository";
import type { Bindings } from "../types/bindings";

export { MAX_COURSE_INFO_CALLS } from "./contract";
import { COURSE_INFO_PAGE_SIZE } from "../domain/conversation/evidence";
export { COURSE_DESCRIPTION_LIMIT, VIDEO_DESCRIPTION_LIMIT } from "../domain/conversation/evidence";
import { createCourseInfoService } from "../features/evidence/course-info-service";

/** Only server-authorized course context may be captured here, never model arguments. */
export function createCourseInfoTool(
  env: Bindings,
  scope: { courseId: number; ownerUserId: string; videoIds?: readonly number[] },
) {
  const execute = createCourseInfoService(options => getCourseInfo(env, scope.courseId, scope.ownerUserId, {
    ...options, ...(scope.videoIds !== undefined ? { videoIds: scope.videoIds } : {}),
  }));
  return defineTool(
    execute,
    {
      name: "get_course_info",
      description:
        "Read the current course's registered name, description, total video count and a page of " +
        "videos with IDs, titles, descriptions, list positions and processing status. " +
        "Use for requests for these registered fields or to identify videos before search_scenes. " +
        "This is registered metadata, not evidence of lecture content: continue with search_scenes " +
        "or overview_video/skim_video for definitions, explanations or content summaries. " +
        "Follow videos_meta.next_offset for more videos. List position is not a lecture number. " +
        "Truncated descriptions and missing pages are incomplete evidence, not absent content.",
      schema: z.object({
        video_limit: z.number().int().min(1).max(COURSE_INFO_PAGE_SIZE),
        video_offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      }).strict(),
    },
  );
}
