import * as tags from '../../domain/learning/course-tags';
import { forbidden, conflict, tooLarge } from '../../application/errors';
import { createLtiSessionProof } from '../../application/lti-session-proof';
import type { CourseTagCommand, CourseTagScope } from '../../application/course-tags';
export { visible, refineTagScope, assignmentRevision, type TagResource } from '../../domain/learning/course-tags';

export const tagDenied = () => forbidden('Course tags are unavailable.');
export const tagConflict = (message = 'Tags changed. Refresh before saving.') => conflict(message);
function failure(error: unknown): never {
  if (error instanceof tags.CourseTagDenied) throw forbidden(error.message);
  if (error instanceof tags.CourseTagConflict) throw conflict(error.message);
  if (error instanceof tags.CourseTagLimit) throw tooLarge(error.message);
  throw error;
}
function checked<Args extends unknown[], Result>(decide: (...args: Args) => Result) {
  return (...args: Args): Result => { try { return decide(...args); } catch (error) { return failure(error); } };
}
function checkedAsync<Args extends unknown[], Result>(decide: (...args: Args) => Promise<Result>) {
  return async (...args: Args): Promise<Result> => { try { return await decide(...args); } catch (error) { return failure(error); } };
}
export const tagCatalog = checkedAsync(tags.tagCatalog);
export const requireManagedVideos = checked(tags.requireManagedVideos);
export const assertTagCatalogSize = checked(tags.assertTagCatalogSize);
export const assertTagOperationIdentity = checked(tags.assertTagOperationIdentity);
export const assertTagOperationAvailable = checked(tags.assertTagOperationAvailable);
export const checkTagMutation = checkedAsync(tags.checkTagMutation);

export function checkCourseTags(scope:CourseTagScope,input:CourseTagCommand):void{
 checked(tags.checkCourseTagAccess)(scope, input);
 if(scope.sessionProof){createLtiSessionProof(scope.sessionProof,scope.sessionProof.sessionHash);if(scope.sessionProof.registrationId!=='db:'+scope.installationId)throw tagDenied();}
}
