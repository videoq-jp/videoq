import {
  normalizeShareSlug,
  SLUG_ALREADY_EXISTS_MESSAGE,
} from "@videoq/domain/share-slug";
import type { CourseRepository } from "../../persistence/contracts/course-repository";
import type { CreationIdempotency } from "../../persistence/contracts/creation-idempotency";

/** Application workflow; persistence is supplied by the composition root. */
export function createCourseService(courses: CourseRepository) {
  async function getCourse(courseId: number, userId: string) {
    return courses.getDetail(courseId, userId, { includeTags: false });
  }

  async function getSharedCourse(slug: string) {
    return courses.getShared(slug, { includeTags: false });
  }

  async function createUserCourse(
    userId: string,
    name: string,
    description: string,
  ) {
    const created = await courses.create(userId, name, description);
    if ("idempotencyConflict" in created) {
      throw new Error("Unexpected idempotency conflict without an idempotency key.");
    }
    return courses.getDetail(created.courseId, userId, { includeTags: false });
  }

  /** MCP 用: 同じ key + payload の再試行では同じ講座を返す。 */
  async function createUserCourseIdempotent(
    userId: string,
    name: string,
    description: string,
    idempotency: CreationIdempotency,
  ) {
    const created = await courses.create(
      userId,
      name,
      description,
      idempotency,
    );
    if ("idempotencyConflict" in created) return created;
    return {
      course: await courses.getDetail(created.courseId, userId, { includeFileUrls: false }),
      reused: created.reused,
    } as const;
  }

  async function saveShareLink(
    courseId: number,
    userId: string,
    rawSlug: string,
  ) {
    const norm = normalizeShareSlug(rawSlug);
    if ("error" in norm) {
      const owned = await courses.ownedBy(courseId, userId);
      return owned ? { error: norm.error } as const : { notFound: true } as const;
    }
    const res = await courses.setShareSlug(courseId, userId, norm.slug);
    if ("notFound" in res) return res;
    if ("conflict" in res) {
      return { conflict: SLUG_ALREADY_EXISTS_MESSAGE } as const;
    }
    return { share_slug: norm.slug } as const;
  }

  return {
    getCourse, getSharedCourse, createUserCourse, createUserCourseIdempotent, saveShareLink,
    listCourses: (userId: string, limit: number, offset: number) => courses.listPage(userId, limit, offset),
    updateUserCourse: (id: number, userId: string, fields: { name?: string; description?: string }) => courses.update(id, userId, fields),
    removeCourse: (id: number, userId: string) => courses.delete(id, userId),
    reorderUserCourses: (userId: string, ids: number[]) => courses.reorder(userId, ids),
    clearShareLink: (id: number, userId: string) => courses.clearShareSlug(id, userId),
  };
}
