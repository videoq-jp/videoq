import { EvidenceBudget } from '../../domain/conversation/evidence-budget';
import type { CourseInfo, CourseInfoOptions } from '../../persistence/contracts/course-repository';
import { COURSE_DESCRIPTION_LIMIT, VIDEO_DESCRIPTION_LIMIT } from '../../domain/conversation/evidence';

/** Scope is captured by the outer capability; model arguments cannot select an owner or course. */
export function createCourseInfoService(load: (options: Omit<CourseInfoOptions, 'videoIds'>) => Promise<CourseInfo | null>) {
  const budget = new EvidenceBudget();
  return async ({ video_limit, video_offset }: { video_limit: number; video_offset: number }) => {
    if (budget.reserveTool('course') === 'limit') {
      return "Course information limit reached. Answer using the information already retrieved; " +
        "state any missing pages or details instead of guessing.";
    }
    const course = await load({
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
  };
}
