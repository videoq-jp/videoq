export type StepKey = 'upload' | 'transcribe' | 'ask' | 'course';
// Questions are asked from a course's chat, so the course comes before asking.
export const STEP_ORDER: StepKey[] = ['upload', 'transcribe', 'course', 'ask'];

export interface GettingStartedProgress {
  hasVideos: boolean;
  hasProcessingVideos: boolean;
  hasCompletedVideos: boolean;
  /** The user owns a course (joined courses do not count). */
  hasCourse: boolean;
  hasCourseVideos: boolean;
  hasAskedQuestion: boolean;
}

export function gettingStartedState(progress: GettingStartedProgress) {
  const done: Record<StepKey, boolean> = {
    upload: progress.hasVideos,
    transcribe: progress.hasCompletedVideos,
    course: progress.hasCourse && progress.hasCourseVideos,
    ask: progress.hasAskedQuestion,
  };
  const currentKey = STEP_ORDER.find(key => !done[key]);
  return { done, currentKey, isWaiting: currentKey === 'transcribe' && progress.hasProcessingVideos };
}
