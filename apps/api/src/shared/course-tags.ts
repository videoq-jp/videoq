import { MAX_COURSE_TAGS, type CourseTagCommand } from '../application/course-tags';
import {z} from 'zod';
import {tagColorSchema} from '@videoq/trpc';
import { asApiError } from './errors';
import * as policy from '../features/course-tags/policy';
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
    tagIds: z.array(z.uuid()).max(MAX_COURSE_TAGS).refine(ids => new Set(ids).size === ids.length).transform(ids => ids.sort()),
  }).strict(),
]);

function adapt<T>(operation: () => T): T {
  try { return operation(); } catch (error) { throw asApiError(error) ?? error; }
}
export const tagDenied = () => asApiError(policy.tagDenied())!;
export const tagConflict = (message?: string) => asApiError(policy.tagConflict(message))!;
export const assignmentRevision = (scope: CourseTagScope, videoId: number, ids: string[]) => policy.assignmentRevision(scope, videoId, ids, digest);
export { visible, refineTagScope, type TagResource } from '../features/course-tags/policy';
export async function tagCatalog(all: CourseTag[], scope: CourseTagScope, reused = false) {
  try { return await policy.tagCatalog(all, scope, digest, reused); }
  catch (error) { throw asApiError(error) ?? error; }
}
export function requireManagedVideos(scope: CourseTagScope, ids: number[]) {
  return adapt(() => policy.requireManagedVideos(scope, ids));
}
export function checkCourseTags(scope: CourseTagScope, input: z.infer<typeof courseTagInput>) {
  return adapt(() => policy.checkCourseTags(scope, input));
}

export const assertTagCatalogSize = (count: number) => adapt(() => policy.assertTagCatalogSize(count));
export const assertTagOperationIdentity = (courseMatches: boolean, actorMatches: boolean, requestMatches: boolean) =>
  adapt(() => policy.assertTagOperationIdentity(courseMatches, actorMatches, requestMatches));
export const assertTagOperationAvailable = (available: boolean) => adapt(() => policy.assertTagOperationAvailable(available));
export async function checkTagMutation(scope: CourseTagScope, input: Exclude<CourseTagCommand, { action: 'list' }>, all: CourseTag[]) {
  try { await policy.checkTagMutation(scope, input, all, digest); }
  catch (error) { throw asApiError(error) ?? error; }
}
