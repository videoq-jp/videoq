import { courseHistoryIdentityInput } from '../../application/subject-identity';
import type { ChatAnswer } from '@videoq/domain/chat';
import type { SavedCourseHistory } from '../../application/course-history';
import type { CourseHistoryRepository, CourseHistoryScope } from '../../persistence/contracts/course-history-repository';

export interface CourseHistoryDependencies {
  repository(): Promise<CourseHistoryRepository>;
  digest(value: string): Promise<string>;
  newSecret(): string;
  now(): number;
  decodeHistory(value: unknown): SavedCourseHistory | null;
  decodeAnswer(value: unknown): ChatAnswer | null;
}
export const historyKeyInput = (scope: CourseHistoryScope): string => courseHistoryIdentityInput(scope);
export async function appendCourseHistory(deps: CourseHistoryDependencies, scope: CourseHistoryScope, question: string, logId: number | null, allowed: number[] | undefined) {
  if (logId === null) return;
  await (await deps.repository()).append(scope, await deps.digest(historyKeyInput(scope)), {
    id: deps.newSecret().slice(0, 32), logId, question,
  }, allowed, new Date(deps.now() + 86400_000));
}
export async function readCourseHistory(deps: CourseHistoryDependencies, scope: CourseHistoryScope, ownerUserId: string, videoIds: number[]) {
  const stored = await (await deps.repository()).read(scope, await deps.digest(historyKeyInput(scope)), ownerUserId);
  if (!stored) return [];
  const record = deps.decodeHistory(stored.payload);
  if (!record || !record.scopeVideoIds.every(id => videoIds.includes(id)) || !record.turns.length) return [];
  return record.turns.flatMap(turn => {
    const row = stored.logs.find(row => row.id === turn.logId);
    const answer = deps.decodeAnswer(row?.answer);
    if (!row || !answer || answer.sources.some(source => !videoIds.includes(source.video_id))) return [];
    return [{ ...turn, answer, feedback: row.feedback === 'good' || row.feedback === 'bad' ? row.feedback : null }];
  });
}
