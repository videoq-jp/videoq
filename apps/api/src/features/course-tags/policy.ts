import { forbidden, conflict, tooLarge } from '../../application/errors';
import { createLtiSessionProof } from '../../application/lti-session-proof';
import { MAX_COURSE_TAGS, type CourseTagCommand, type CourseTagScope, type CourseTag } from '../../application/course-tags';

export const tagDenied = () => forbidden('Course tags are unavailable.');
export const tagConflict = (message = 'Tags changed. Refresh before saving.') => conflict(message);
export const assignmentRevision = (scope: CourseTagScope, videoId: number, ids: string[], digest: (value: string) => Promise<string>) =>
  digest(JSON.stringify(['lti-course-tags-v1', scope.courseId, videoId, [...ids].sort()]));

export function visible(tag: CourseTag, scope: CourseTagScope) {
  const allowed = new Set([...scope.readableVideoIds, ...(scope.manage ? scope.management.map(item => item.videoId) : [])]);
  return tag.video_ids.some(id => allowed.has(Number(id))) || (scope.manage && tag.video_ids.length === 0);
}
export async function tagCatalog(all:CourseTag[],scope:CourseTagScope,digest:(value:string)=>Promise<string>,reused=false) {
  assertTagCatalogSize(all.length);
  const management = new Set(scope.manage ? scope.management.map(item => item.videoId) : []);
  const allowed = new Set([...scope.readableVideoIds, ...management]);
  const tags = all.filter(tag => visible(tag, scope)).map(tag => ({ id: tag.id, name: tag.name, color: tag.color,
    revision: tag.revision, videoIds: tag.video_ids.map(Number).filter(id => allowed.has(id)),
    editable: scope.manage && tag.video_ids.every(id => management.has(Number(id))) }));
  const videos = await Promise.all([...allowed].sort((a,b) => a-b).map(async videoId => {
    const tagIds = tags.filter(tag => tag.videoIds.includes(videoId)).map(tag => tag.id).sort();
    return { videoId, tagIds, editable: management.has(videoId), revision: await assignmentRevision(scope, videoId, tagIds, digest) };
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
export function checkCourseTags(scope:CourseTagScope,input:CourseTagCommand):void{
 if(!/^[a-f0-9]{64}$/.test(scope.actorKey)||(input.action!=='list'&&!scope.manage)||scope.readableVideoIds.length>1000||scope.management.length>1000)throw tagDenied();
 if(scope.sessionProof){createLtiSessionProof(scope.sessionProof,scope.sessionProof.sessionHash);if(scope.sessionProof.registrationId!=='db:'+scope.installationId)throw tagDenied();}
}

/** Keep this guard at the adapter's original stage, including on replay. */
export function assertTagCatalogSize(count: number): void {
  if (count > MAX_COURSE_TAGS) throw tooLarge('Too many course tags.');
}
export function assertTagOperationIdentity(courseMatches: boolean, actorMatches: boolean, requestMatches: boolean): void {
  if (!courseMatches || !actorMatches || !requestMatches) throw tagConflict();
}
export function assertTagOperationAvailable(available: boolean): void {
  if (!available) throw tagConflict('This operation is no longer available. Refresh and start a new operation.');
}
export async function checkTagMutation(scope: CourseTagScope, input: Exclude<CourseTagCommand, { action: 'list' }>,
  all: CourseTag[], digest: (value: string) => Promise<string>): Promise<void> {
  if (input.action === 'create') {
    if (all.length >= MAX_COURSE_TAGS) throw tooLarge('Too many course tags.');
  } else if (input.action === 'assign') {
    requireManagedVideos(scope, [input.videoId]);
    if (input.tagIds.some(id => !all.some(tag => tag.id === id && visible(tag, scope)))) throw tagDenied();
    const ids = all.filter(tag => tag.video_ids.includes(String(input.videoId))).map(tag => tag.id);
    if (await assignmentRevision(scope, input.videoId, ids, digest) !== input.revision) throw tagConflict();
  } else {
    const tag = all.find(item => item.id === input.id && visible(item, scope));
    if (!tag) throw tagDenied();
    requireManagedVideos(scope, tag.video_ids.map(Number));
    if (tag.revision !== input.revision) throw tagConflict();
  }
}
