import {z} from 'zod';
import {tagColorSchema} from '@videoq/trpc';
import {ApiError} from './errors';
import {ltiSessionProof} from './lti-session-proof';
import {digest} from '../features/lti/store';
import type {CourseTagScope,CourseTag} from '../persistence/contracts/course-tag-repository';
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
export const tagDenied = () => new ApiError(403, 'FORBIDDEN', 'Course tags are unavailable.');
export const tagConflict = (message = 'Tags changed. Refresh before saving.') => new ApiError(409, 'CONFLICT', message);
export const assignmentRevision = (scope: CourseTagScope, videoId: number, ids: string[]) =>
  digest(JSON.stringify(['lti-course-tags-v1', scope.courseId, videoId, ids.sort()]));

export function visible(tag: CourseTag, scope: CourseTagScope) {
  const allowed = new Set([...scope.readableVideoIds, ...(scope.manage ? scope.management.map(item => item.videoId) : [])]);
  return tag.video_ids.some(id => allowed.has(Number(id))) || (scope.manage && tag.video_ids.length === 0);
}
export async function tagCatalog(all:CourseTag[],scope:CourseTagScope,reused=false) {
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
export function requireManagedVideos(scope: CourseTagScope, ids: number[]) {
  // currentScope locked and checked every source in one query. Avoid one remote
  // database round trip per material when a course tag is used widely.
  const allowed = new Set(scope.management.map(source => source.videoId));
  if (ids.some(id => !allowed.has(id))) throw tagDenied();
}

export type TagResource={video_id:string|number;resource_link_id:string;generation:string|number;status:string};
export function refineTagScope(scope:CourseTagScope,rows:TagResource[]):CourseTagScope{
  return { ...scope,
    readableVideoIds: scope.readableVideoIds.filter(id => rows.some(row => Number(row.video_id) === id && row.status === 'completed')),
    management: scope.manage ? scope.management.filter(source => rows.some(row => Number(row.video_id) === source.videoId
      && row.resource_link_id === source.resourceLinkId && Number(row.generation) === source.generation)) : [],
  };
}
export function checkCourseTags(scope:CourseTagScope,input:z.infer<typeof courseTagInput>):void{
 if(!/^[a-f0-9]{64}$/.test(scope.actorKey)||(input.action!=='list'&&!scope.manage)||scope.readableVideoIds.length>1000||scope.management.length>1000)throw tagDenied();
 if(scope.sessionProof){ltiSessionProof(scope.sessionProof,scope.sessionProof.sessionHash);if(scope.sessionProof.registrationId!=='db:'+scope.installationId)throw tagDenied();}
}
