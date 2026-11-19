import type { Bindings } from "../../types/bindings";
import { membershipService } from "../../integrations/membership";

// Compatibility entrypoints; business workflows live in core.ts.
export function addTagsToVideo(
  env: Bindings,
  userId: string,
  videoId: number,
  tagIds: number[],
) {
  return membershipService(env).addTagsToVideo(userId, videoId, tagIds);
}
export function removeTagFromVideo(
  env: Bindings,
  userId: string,
  videoId: number,
  tagId: number,
) {
  return membershipService(env).removeTagFromVideo(userId, videoId, tagId);
}
export function reorderGroupVideos(
  env: Bindings,
  userId: string,
  courseId: number,
  videoIds: number[],
) {
  return membershipService(env).reorderGroupVideos(userId, courseId, videoIds);
}
export function addVideosToCourseBulk(
  env: Bindings,
  userId: string,
  courseId: number,
  videoIds: number[],
) {
  return membershipService(env).addVideosToCourseBulk(
    userId,
    courseId,
    videoIds,
  );
}
export function addVideoToCourseOne(
  env: Bindings,
  userId: string,
  courseId: number,
  videoId: number,
) {
  return membershipService(env).addVideoToCourseOne(userId, courseId, videoId);
}
export function removeVideoFromCourseOne(
  env: Bindings,
  userId: string,
  courseId: number,
  videoId: number,
) {
  return membershipService(env).removeVideoFromCourseOne(
    userId,
    courseId,
    videoId,
  );
}
