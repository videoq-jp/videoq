import { chatAnswerSchema } from '@videoq/trpc/chat';
import { createCourseHistoryRepository } from '../persistence/factory';
import type { CourseHistoryScope } from '../persistence/contracts/course-history-repository';
import { savedCourseHistory } from '../shared/course-history';
import { digest, randomSecret } from '../features/lti/store';
import * as workflow from '../features/course-history/service';
import type { CourseHistoryDependencies } from '../features/course-history/service';
import type { Bindings } from '../types/bindings';

function dependencies(env: Bindings): CourseHistoryDependencies {
  return {
    repository: () => createCourseHistoryRepository(env), digest, newSecret: randomSecret, now: () => Date.now(),
    decodeHistory: value => { const result = savedCourseHistory.safeParse(value); return result.success ? result.data : null; },
    decodeAnswer: value => { const result = chatAnswerSchema.safeParse(value); return result.success ? result.data : null; },
  };
}
export const courseHistoryId = (scope: CourseHistoryScope) => digest(workflow.historyKeyInput(scope));
export function appendCourseHistory(env: Bindings, scope: CourseHistoryScope, question: string, logId: number | null, allowed: number[] | undefined) {
  return workflow.appendCourseHistory(dependencies(env), scope, question, logId, allowed);
}
export function readCourseHistory(env: Bindings, scope: CourseHistoryScope, ownerUserId: string, videoIds: number[]) {
  return workflow.readCourseHistory(dependencies(env), scope, ownerUserId, videoIds);
}
