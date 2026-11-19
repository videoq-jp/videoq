import { defineTool } from "./definition";
import { z } from "zod";
import { getCourseInfo } from "../repositories/course-repository";
import type { Bindings } from "../types/bindings";

import { MAX_COURSE_INFO_CALLS } from "./contract";
export { MAX_COURSE_INFO_CALLS } from "./contract";
const COURSE_INFO_PAGE_SIZE = 20;
export const COURSE_DESCRIPTION_LIMIT = 2000;
export const VIDEO_DESCRIPTION_LIMIT = 500;

/** Only server-authorized course context may be captured here, never model arguments. */
export function createCourseInfoTool(
  env: Bindings,
  scope: { courseId: number; ownerUserId: string; videoIds?: readonly number[] },
) {
  let used = 0;
  return defineTool(
    async ({ video_limit, video_offset }) => {
      if (used++ >= MAX_COURSE_INFO_CALLS) {
        return "Course information limit reached. Answer using the information already retrieved; " +
          "state any missing pages or details instead of guessing.";
      }
      const course = await getCourseInfo(env, scope.courseId, scope.ownerUserId, {
        ...(scope.videoIds !== undefined ? { videoIds: scope.videoIds } : {}),
        videoLimit: video_limit,
        videoOffset: video_offset,
        courseDescriptionLimit: COURSE_DESCRIPTION_LIMIT,
        videoDescriptionLimit: VIDEO_DESCRIPTION_LIMIT,
      });
      if (!course) return "The current course is no longer available.";
      // Explicit projection: never pass shared tokens, user IDs or file URLs to the model.
      const nextOffset = video_offset + course.videos.length;
      const hasMore = nextOffset < course.video_count && course.videos.length > 0;
      const result = {
        name: course.name,
        description: course.description.slice(0, COURSE_DESCRIPTION_LIMIT),
        description_truncated: course.description.length > COURSE_DESCRIPTION_LIMIT,
        video_count: course.video_count,
        videos: course.videos.map((video, index) => ({
          id: video.id,
          title: video.title,
          description: video.description.slice(0, VIDEO_DESCRIPTION_LIMIT),
          description_truncated: video.description.length > VIDEO_DESCRIPTION_LIMIT,
          position: video_offset + index + 1,
          order: video.order,
          status: video.status,
        })),
        videos_meta: {
          total: course.video_count,
          limit: video_limit,
          offset: video_offset,
          has_more: hasMore,
          next_offset: hasMore ? nextOffset : null,
        },
      };
      return result;
    },
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
