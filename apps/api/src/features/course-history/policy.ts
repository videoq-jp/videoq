import { forbidden } from '../../application/errors';
import { createLtiSessionProof } from '../../application/lti-session-proof';
import type { CourseHistoryScope } from '../../persistence/contracts/course-history-repository';

export const historyDenied = () => forbidden('The Moodle session is unavailable.');
export function checkHistoryScope(scope: CourseHistoryScope): void {
  if (scope.sessionProof) {
    createLtiSessionProof(scope.sessionProof, scope.sessionProof.sessionHash);
    if (scope.registrationId !== scope.sessionProof.registrationId || scope.subjectHash !== scope.sessionProof.subjectHash) throw historyDenied();
  }
}
