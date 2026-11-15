import type pg from 'pg';
import {withDb} from '../../db/pool';
import {reserveLtiOperation} from './operation-reservations';
import {lockLmsGrant} from './lms-resource-repository';
import {lockLtiDataSessionWithDb} from './lti-session-lock';
import {tagDenied as denied,tagConflict as conflict,assignmentRevision,visible,requireManagedVideos,refineTagScope,tagCatalog,checkCourseTags} from '../../shared/course-tags';
import {digest} from '../../features/lti/store';
import {ApiError} from '../../shared/errors';
import type {Bindings} from '../../types/bindings';
import type {CourseTagRepository,CourseTagScope,CourseTag} from '../contracts/course-tag-repository';
async function readTags(client: pg.Client, scope: CourseTagScope) {
  return (await client.query<CourseTag>(`SELECT t.id,t.name,t.color,t.revision,
    ARRAY(SELECT v.video_id::text FROM lti_course_video_tags v WHERE v.tag_id=t.id ORDER BY v.video_id) AS video_ids
    FROM lti_course_tags t WHERE t.course_id=$1 ORDER BY t.name,t.id LIMIT 201`, [scope.courseId])).rows;
}
async function catalog(client:pg.Client,scope:CourseTagScope,reused=false){return tagCatalog(await readTags(client,scope),scope,reused);}
async function currentScope(client: pg.Client, scope: CourseTagScope): Promise<CourseTagScope> {
  const candidates = [...new Set([...scope.readableVideoIds, ...scope.management.map(item => item.videoId)])];
  const rows = (await client.query<{ video_id: string; resource_link_id: string; generation: string; status: string }>(
    `SELECT r.video_id,r.resource_link_id,r.generation,v.status FROM lms_resources r
      JOIN video_course_members m ON m.video_id=r.video_id AND m.course_id=r.course_id
      JOIN videos v ON v.id=r.video_id AND v.managed_by_lms=true
      WHERE r.installation_id=$1 AND r.context_id=$2 AND r.course_id=$3 AND v.user_id=$4
        AND r.enabled=true AND r.video_id=ANY($5::bigint[]) FOR SHARE OF r,m,v`,
    [scope.installationId,scope.contextId,scope.courseId,scope.ownerUserId,candidates])).rows;
  return refineTagScope(scope,rows);
}
export function createPostgresCourseTagRepository(env:Bindings):CourseTagRepository{return {async execute(scope,input){
 checkCourseTags(scope,input);
  return withDb(env, async (db, client) => {
    await client.query('BEGIN');
    try {
      await lockLmsGrant(db, { id: scope.installationId, ownerUserId: scope.ownerUserId },scope.contextId,scope.courseId);
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
}};}
