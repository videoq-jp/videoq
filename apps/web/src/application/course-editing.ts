import { canManageCourse } from './course-access';

export type CourseMetadata = { name: string; description?: string | null };
export type CourseMetadataPatch = { name?: string; description?: string };

export function changedCourseMetadata(current: CourseMetadata | undefined, payload: CourseMetadataPatch): CourseMetadataPatch {
  return {
    ...(payload.name !== undefined && payload.name !== current?.name ? { name: payload.name } : {}),
    ...(payload.description !== undefined && payload.description !== current?.description ? { description: payload.description } : {}),
  };
}

/** A drag started against an older membership snapshot must not drop new videos.
 * Return the original array when the requested order cannot represent this set. */
export function reorderCourseVideos<Video extends { id: number }>(videos: Video[] | undefined, ids: readonly number[]): Video[] | undefined {
  if (!videos || videos.length !== ids.length || new Set(ids).size !== ids.length) return videos;
  const byId = new Map(videos.map(video => [video.id, video]));
  if (ids.some(id => !byId.has(id))) return videos;
  return ids.map((id, order) => ({ ...byId.get(id)!, order }));
}

export function addableCourseVideos<Video extends { id: number }>(current: readonly { id: number }[] | undefined, library: readonly Video[]): Video[] {
  if (!current) return [];
  const existing = new Set(current.map(video => video.id));
  return library.filter(video => !existing.has(video.id));
}

/** Roll back only the optimistic order we installed, retaining newer metadata
 * and any membership/order snapshot that arrived after the write began. */
export function rollbackCourseVideoOrder<Course extends { videos?: unknown[] }>(
  current: Course | undefined,
  previous: Course | undefined,
  optimistic: Course | undefined,
): Course | undefined {
  return current && previous && current.videos === optimistic?.videos
    ? { ...current, videos: previous.videos }
    : current;
}

/** Joined courses remain outside the owner's editable ordering. */
export function partitionCourseAccess<Course extends { access_role?: string }>(courses: readonly Course[]) {
  return {
    ownedCourses: courses.filter(canManageCourse),
    joinedCourses: courses.filter(course => !canManageCourse(course)),
  };
}

/** Keep an in-flight order while incorporating newly loaded owned courses. */
export function loadedCourseOrder<Course extends { id: number }>(courses: Course[], orderedIds: readonly number[] | null): Course[] {
  if (!orderedIds) return courses;
  const byId = new Map(courses.map(course => [course.id, course]));
  const ordered = orderedIds.map(id => byId.get(id)).filter((course): course is Course => Boolean(course));
  const included = new Set(ordered.map(course => course.id));
  return [...ordered, ...courses.filter(course => !included.has(course.id))];
}
