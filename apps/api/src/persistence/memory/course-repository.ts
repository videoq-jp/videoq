/* eslint @typescript-eslint/require-await: "off" -- Implements an async persistence port with synchronous, atomic in-memory mutations. */
import type { CourseDetail, CourseRepository } from '../contracts/course-repository';
import { creationReceiptResult, validateCreationIdempotency } from '../../application/creation-idempotency';
import { courseArrayOrderPlanning, planSelectedCourseOrder, validCourseOrderInput } from '../../domain/learning/course-management';

type Seed = { ownerId: string; course: CourseDetail; members?: readonly string[] };

/** Local development adapter. Each composition owns its state; no DB, global
 * singleton, network or production-backend selection is involved.
 */
export function createMemoryCourseRepository(options: { now: () => Date; seed?: readonly Seed[] }): CourseRepository {
  const records = new Map((options.seed ?? []).map(row => [row.course.id, structuredClone(row)]));
  const receipts = new Map<string, { requestHash: string; resourceId: number }>();
  let nextId = Math.max(0, ...records.keys()) + 1;
  const owned = (id: number, user: string) => {
    const row = records.get(id);
    return row?.ownerId === user ? row : undefined;
  };
  const detail = (row: Seed, role: CourseDetail['access_role']): CourseDetail =>
    structuredClone({ ...row.course, video_count: row.course.videos.length, access_role: role });
  const visible = (id: number, user: string) => {
    const row = records.get(id);
    return row && (row.ownerId === user || row.members?.includes(user)) ? row : undefined;
  };
  return {
    async getInfo(id, user, limits) {
      const row = owned(id, user);
      if (!row) return null;
      const videos = row.course.videos.filter(video => !limits.videoIds || limits.videoIds.includes(video.id));
      return { name: row.course.name, description: row.course.description.slice(0, limits.courseDescriptionLimit),
        video_count: videos.length, videos: videos.slice(limits.videoOffset, limits.videoOffset + limits.videoLimit)
          .map(video => ({ id: video.id, title: video.title, description: video.description.slice(0, limits.videoDescriptionLimit), status: video.status, order: video.order })) };
    },
    async getDetail(id, user, limits) {
      const row = visible(id, user);
      if (!row) return null;
      const result = detail(row, row.ownerId === user ? 'owner' : 'member');
      const offset = limits?.videoOffset ?? 0;
      result.videos = result.videos.slice(offset, limits?.videoLimit === undefined ? undefined : offset + limits.videoLimit);
      return result;
    },
    async getShared(slug) {
      const row = [...records.values()].find(row => row.course.share_slug === slug);
      return row ? detail(row, 'public') : null;
    },
    async create(user, name, description, idempotency) {
      validateCreationIdempotency(idempotency, 'create_course');
      const key = idempotency ? JSON.stringify([user, idempotency.action, idempotency.key]) : undefined;
      if (key && idempotency) {
        const previous = creationReceiptResult(receipts.get(key), idempotency.requestHash);
        if (previous.found) return previous.conflict || !records.has(previous.resourceId)
          ? { idempotencyConflict: true } : { ok: true, courseId: previous.resourceId, reused: true };
      }
      const id = nextId++;
      const time = options.now().toISOString();
      const order = Math.max(-1, ...[...records.values()].filter(row => row.ownerId === user).map(row => row.course.display_order)) + 1;
      records.set(id, { ownerId: user, course: { id, name, description, display_order: order,
        created_at: time, updated_at: time, video_count: 0, share_slug: null, videos: [], access_role: 'owner' } });
      if (key && idempotency) receipts.set(key, { requestHash: idempotency.requestHash, resourceId: id });
      return { ok: true, courseId: id, reused: false };
    },
    async update(id, user, fields) {
      const row = owned(id, user);
      if (!row) return { notFound: true };
      Object.assign(row.course, fields, { updated_at: options.now().toISOString() });
      return { course: detail(row, 'owner') };
    },
    async delete(id, user) {
      if (!owned(id, user)) return { notFound: true };
      records.delete(id);
      return { ok: true };
    },
    async reorder(user, ids) {
      if (!validCourseOrderInput(ids) || ids.some(id => !owned(id, user))) return { mismatch: true };
      const slots = ids.map(id => records.get(id)!.course.display_order);
      for (const { id, slot } of planSelectedCourseOrder(ids, slots, courseArrayOrderPlanning)) records.get(id)!.course.display_order = slot;
      return { ok: true };
    },
    async ownedBy(id, user) { return !!owned(id, user); },
    async setShareSlug(id, user, slug) {
      const row = owned(id, user);
      if (!row) return { notFound: true };
      if ([...records.values()].some(other => other.course.id !== id && other.course.share_slug === slug)) return { conflict: true };
      row.course.share_slug = slug;
      return { ok: true };
    },
    async clearShareSlug(id, user) {
      const row = owned(id, user);
      if (!row) return { notFound: true };
      if (row.course.share_slug === null) return { notConfigured: true };
      row.course.share_slug = null;
      return { ok: true };
    },
    async listPage(user, limit, offset) {
      const rows = [...records.values()].filter(row => !!visible(row.course.id, user))
        .sort((a, b) => Number(b.ownerId === user) - Number(a.ownerId === user)
          || a.course.display_order - b.course.display_order || b.course.created_at.localeCompare(a.course.created_at) || a.course.id - b.course.id);
      return { count: rows.length, results: rows.slice(offset, offset + limit).map(row => {
        const { id, name, description, display_order, created_at, video_count } = detail(row, 'owner');
        return { id, name, description, display_order, created_at, video_count, access_role: row.ownerId === user ? 'owner' : 'member' };
      }) };
    },
  };
}
