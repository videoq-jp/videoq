import type { MembershipRepository } from "../../persistence/contracts/membership-repository";

export function createMembershipService(repository: MembershipRepository) {
  async function addTagsToVideo(
    userId: string,
    videoId: number,
    tagIds: number[],
  ) {
    const result = await repository.attachTags(videoId, userId, tagIds);
    if ("notFound" in result) return result;
    return {
      ok: true as const,
      message: `Added ${result.added} tags to video`,
      added_count: result.added,
      skipped_count: tagIds.length - result.added,
    };
  }

  async function removeTagFromVideo(
    userId: string,
    videoId: number,
    tagId: number,
  ) {
    const result = await repository.detachTag(videoId, tagId, userId);
    if ("notFound" in result) return result;
    return { ok: true as const, message: "Tag removed from video" };
  }

  async function reorderGroupVideos(
    userId: string,
    courseId: number,
    videoIds: number[],
  ) {
    const result = await repository.reorderVideos(courseId, userId, videoIds);
    if ("notFound" in result) {
      return { notFound: "Course not found" } as const;
    }
    if ("mismatch" in result) {
      return {
        badRequest: "Specified video IDs do not match videos in course",
      } as const;
    }

    return { ok: true as const, message: "Video order updated" };
  }

  async function addVideosToCourseBulk(
    userId: string,
    courseId: number,
    videoIds: number[],
  ) {
    const result = await repository.addVideosBulk(courseId, videoIds, userId);
    if ("notFound" in result) return result;
    const { added } = result;
    return {
      ok: true as const,
      message: `Added ${added} videos to course`,
      added_count: added,
      skipped_count: videoIds.length - added,
    };
  }

  async function addVideoToCourseOne(
    userId: string,
    courseId: number,
    videoId: number,
  ) {
    const r = await repository.addVideoToCourse(courseId, videoId, userId);
    if ("notFound" in r) return r;
    if ("alreadyIn" in r) {
      return {
        ok: true as const,
        message: "Video is already in the course",
        id: r.id,
        reused: true,
      };
    }
    return {
      ok: true as const,
      message: "Video added to course",
      id: r.id,
      reused: false,
    };
  }

  async function removeVideoFromCourseOne(
    userId: string,
    courseId: number,
    videoId: number,
  ) {
    const r = await repository.removeVideoFromCourse(courseId, videoId, userId);
    if ("notFound" in r) return r;
    if ("notMember" in r) {
      return { notFound: "This video is not added to the course" } as const;
    }
    return { ok: true as const };
  }

  return {
    addTagsToVideo,
    removeTagFromVideo,
    reorderGroupVideos,
    addVideosToCourseBulk,
    addVideoToCourseOne,
    removeVideoFromCourseOne,
  };
}
