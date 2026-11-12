import { reserveLtiOperation } from './operation-reservations';
import { z } from 'zod';
import { tagColorSchema } from '@videoq/trpc';
import type pg from 'pg';
import { withDb } from '../../db/pool';
import { lockLmsGrant } from '../../repositories/lms-resource-repository';
import { ApiError } from '../../shared/errors';
import type { Bindings } from '../../types/bindings';
import { digest } from './store';
import { lockLtiDataSessionWithDb, type LtiSessionProof } from './data-lock';

const name = z.string().trim().min(1).max(50).refine(value => [...value].every(char => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127));
const operation = { operationId: z.uuid() };
export const courseTagInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('create'), ...operation, name, color: tagColorSchema.default('gray') }).strict(),
  z.object({ action: z.literal('update'), ...operation, id: z.uuid(), revision: z.uuid(), name, color: tagColorSchema }).strict(),
  z.object({ action: z.literal('delete'), ...operation, id: z.uuid(), revision: z.uuid() }).strict(),
  z.object({ action: z.literal('assign'), ...operation, videoId: z.number().int().positive().safe(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    tagIds: z.array(z.uuid()).max(200).refine(ids => new Set(ids).size === ids.length).transform(ids => ids.sort()),
  }).strict(),
]);
export type CourseTagScope = {
  installationId: string; contextId: string; courseId: number; ownerUserId: string; actorKey: string;
  readableVideoIds: number[]; manage: boolean;
  management: { videoId: number; resourceLinkId: string; generation: number }[];
  sessionProof?: LtiSessionProof;
};
type Tag = { id: string; name: string; color: string; revision: string; video_ids: string[] };
const denied = () => new ApiError(403, 'FORBIDDEN', 'Course tags are unavailable.');
const conflict = (message = 'Tags changed. Refresh before saving.') => new ApiError(409, 'CONFLICT', message);
const assignmentRevision = (scope: CourseTagScope, videoId: number, ids: string[]) =>
  digest(JSON.stringify(['lti-course-tags-v1', scope.courseId, videoId, ids.sort()]));

async function readTags(client: pg.Client, scope: CourseTagScope) {
  return (await client.query<Tag>(`SELECT t.id,t.name,t.color,t.revision,
    ARRAY(SELECT v.video_id::text FROM lti_course_video_tags v WHERE v.tag_id=t.id ORDER BY v.video_id) AS video_ids
    FROM lti_course_tags t WHERE t.course_id=$1 ORDER BY t.name,t.id LIMIT 201`, [scope.courseId])).rows;
}
function visible(tag: Tag, scope: CourseTagScope) {
  const allowed = new Set([...scope.readableVideoIds, ...(scope.manage ? scope.management.map(item => item.videoId) : [])]);
  return tag.video_ids.some(id => allowed.has(Number(id))) || (scope.manage && tag.video_ids.length === 0);
}
async function catalog(client: pg.Client, scope: CourseTagScope, reused = false) {
  const all = await readTags(client, scope);
  if (all.length > 200) throw new ApiError(413, 'VALIDATION_ERROR', 'Too many course tags.');
  const management = new Set(scope.manage ? scope.management.map(item => item.videoId) : []);
  const allowed = new Set([...scope.readableVideoIds, ...management]);
  const tags = all.filter(tag => visible(tag, scope)).map(tag => ({ id: tag.id, name: tag.name, color: tag.color,
    revision: tag.revision, videoIds: tag.video_ids.map(Number).filter(id => allowed.has(id)),
    editable: scope.manage && tag.video_ids.every(id => management.has(Number(id))) }));
  const videos = await Promise.all([...allowed].sort((a,b) => a-b).map(async videoId => {
    const tagIds = tags.filter(tag => tag.videoIds.includes(videoId)).map(tag => tag.id).sort();
    return { videoId, tagIds, editable: management.has(videoId), revision: await assignmentRevision(scope, videoId, tagIds) };
  }));
  return { tags, videos, canManage: scope.manage, reused };
}
function requireManagedVideos(scope: CourseTagScope, ids: number[]) {
  // currentScope locked and checked every source in one query. Avoid one remote
  // database round trip per material when a course tag is used widely.
  const allowed = new Set(scope.management.map(source => source.videoId));
  if (ids.some(id => !allowed.has(id))) throw denied();
}

async function currentScope(client: pg.Client, scope: CourseTagScope): Promise<CourseTagScope> {
  const candidates = [...new Set([...scope.readableVideoIds, ...scope.management.map(item => item.videoId)])];
  const rows = (await client.query<{ video_id: string; resource_link_id: string; generation: string; status: string }>(
    `SELECT r.video_id,r.resource_link_id,r.generation,v.status FROM lms_resources r
      JOIN video_course_members m ON m.video_id=r.video_id AND m.course_id=r.course_id
      JOIN videos v ON v.id=r.video_id AND v.managed_by_lms=true
      WHERE r.installation_id=$1 AND r.context_id=$2 AND r.course_id=$3 AND v.user_id=$4
        AND r.enabled=true AND r.video_id=ANY($5::bigint[]) FOR SHARE OF r,m,v`,
    [scope.installationId,scope.contextId,scope.courseId,scope.ownerUserId,candidates])).rows;
  return { ...scope,
    readableVideoIds: scope.readableVideoIds.filter(id => rows.some(row => Number(row.video_id) === id && row.status === 'completed')),
    management: scope.manage ? scope.management.filter(source => rows.some(row => Number(row.video_id) === source.videoId
      && row.resource_link_id === source.resourceLinkId && Number(row.generation) === source.generation)) : [],
  };
}

/** Scope is assembled only after fresh Moodle access and VideoQ membership checks. */
export async function courseTags(env: Bindings, scope: CourseTagScope, input: z.infer<typeof courseTagInput>) {
  if (!/^[a-f0-9]{64}$/.test(scope.actorKey) || (input.action !== 'list' && !scope.manage)) throw denied();
  return withDb(env, async (db, client) => {
    await client.query('BEGIN');
    try {
      await lockLmsGrant(db, { id: scope.installationId, ownerUserId: scope.ownerUserId });
      await lockLtiDataSessionWithDb(db,scope.ownerUserId,scope.sessionProof);
      const binding = await client.query(`SELECT c.id FROM lms_courses c JOIN video_courses v ON v.id=c.course_id
        WHERE c.installation_id=$1 AND c.context_id=$2 AND c.course_id=$3 AND v.user_id=$4 AND v.managed_by_lms=true FOR SHARE OF c,v`,
      [scope.installationId,scope.contextId,scope.courseId,scope.ownerUserId]);
      if (binding.rowCount !== 1) throw denied();
      // Synchronization/processing can change after the Moodle permission fetch.
      // Recheck the current binding and membership while holding the writer lock.
      scope = await currentScope(client, scope);
      if (input.action === 'list') {
        const result = await catalog(client, scope); await client.query('COMMIT'); return result;
      }
      const hash = await digest(JSON.stringify(input));
      const freshOperation = await reserveLtiOperation(client, 'tag', input.operationId);
      const prior = (await client.query<{ course_id: string; actor_key: string; request_hash: string }>(
        'SELECT course_id,actor_key,request_hash FROM lti_course_tag_operations WHERE id=$1', [input.operationId])).rows[0];
      if (prior) {
        if (Number(prior.course_id) !== scope.courseId || prior.actor_key !== scope.actorKey || prior.request_hash !== hash) throw conflict();
        const result = await catalog(client, scope, true); await client.query('COMMIT'); return result;
      }
      if (!freshOperation) throw conflict('This operation is no longer available. Refresh and start a new operation.');
      const all = await readTags(client, scope);
      if (input.action === 'create') {
        if (all.length >= 200) throw new ApiError(413, 'VALIDATION_ERROR', 'Too many course tags.');
        await client.query('INSERT INTO lti_course_tags(id,course_id,name,color) VALUES($1,$2,$3,$4)',
        [input.operationId, scope.courseId, input.name, input.color]);
      } else if (input.action === 'assign') {
        requireManagedVideos(scope, [input.videoId]);
        if (input.tagIds.some(id => !all.some(tag => tag.id === id && visible(tag, scope)))) throw denied();
        const ids = all.filter(tag => tag.video_ids.includes(String(input.videoId))).map(tag => tag.id);
        if (await assignmentRevision(scope, input.videoId, ids) !== input.revision) throw conflict();
        await client.query('DELETE FROM lti_course_video_tags v USING lti_course_tags t WHERE v.tag_id=t.id AND t.course_id=$1 AND v.video_id=$2', [scope.courseId,input.videoId]);
        for (const id of input.tagIds) await client.query('INSERT INTO lti_course_video_tags(tag_id,video_id) VALUES($1,$2)', [id,input.videoId]);
      } else {
        const tag = all.find(item => item.id === input.id && visible(item, scope));
        if (!tag) throw denied();
        requireManagedVideos(scope, tag.video_ids.map(Number));
        if (tag.revision !== input.revision) throw conflict();
        if (input.action === 'delete') await client.query('DELETE FROM lti_course_tags WHERE id=$1 AND course_id=$2', [input.id,scope.courseId]);
        else await client.query('UPDATE lti_course_tags SET name=$1,color=$2,revision=$3 WHERE id=$4 AND course_id=$5',
        [input.name,input.color,crypto.randomUUID(),input.id,scope.courseId]);
      }
      await client.query('INSERT INTO lti_course_tag_operations(id,course_id,actor_key,action,request_hash) VALUES($1,$2,$3,$4,$5)',
      [input.operationId,scope.courseId,scope.actorKey,input.action,hash]);
      const result = await catalog(client, scope); await client.query('COMMIT'); return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') throw conflict();
      throw error;
    }
  });
}
