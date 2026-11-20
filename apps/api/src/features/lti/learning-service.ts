import type { LearningAuthorization } from '../../application/lti-authorization';
import type { VideoEvidence } from '../../persistence/contracts/video-evidence-repository';
import type { ChatRepository } from '../../persistence/contracts/chat-repository';
import { transcriptPage } from './transcript';
import type { CourseAccess } from '../../application/lms-authority';
import type { LearningCourse, LearningGrant } from '../../application/native-learning';
import type { LtiRegistration } from '../../application/lti-registration';
import { learningFeatures } from '../../application/lti-authorization';
import { playbackCueHint } from './playback-context';

export type LearningChatMessage = { role: 'user' | 'assistant' | 'system'; content: string };
export type LearningChatInput = {
  messages: LearningChatMessage[]; conversationId?: string; resumeConversation?: boolean;
  playback?: { videoId: number; seconds: number };
};
export interface LearningChatDependencies {
  subjectKey(): Promise<string>;
  recordScope(videoIds: number[]): Promise<number[] | null>;
  course(videoIds: number[] | undefined): Promise<LearningCourse | null>;
  transcript(ownerUserId: string, videoIds: number[], videoId: number): Promise<string | null>;
  validateMessages(messages: LearningChatMessage[]): LearningChatMessage[] | null;
}

export function learningMaterials(current: CourseAccess, course: LearningCourse, reg: LtiRegistration, grant: LearningGrant) {
  return { ...(current.courseTitle ? { courseTitle: current.courseTitle } : {}),
    courseHistoryAvailable: ownerLearningHistoryAvailable(current), permissions: current.permissions,
    learningAvailable: current.videos.length > 0,
    ...(grant.transport === 'native' ? { nativeProtocol: 1, features: learningFeatures(reg, grant) } : {}),
    order: (current.materialOrder ?? [...current.videos, ...(current.managementVideos ?? [])].map(video => video.videoId))
      .filter(videoId => course.memberVideoIds.includes(videoId)),
    videos: current.videos.filter(video => course.memberVideoIds.includes(video.videoId)),
    managementVideos: (current.managementVideos ?? []).filter(video => course.memberVideoIds.includes(video.videoId)),
  };
}

/** Never feed prior answers from a removed material scope back into generation. */
export async function prepareLearningChat(current: CourseAccess | null, grant: LearningGrant, input: LearningChatInput, deps: LearningChatDependencies) {
  if (current && !current.videos.length) return { denied: 'forbidden' as const };
  if (input.conversationId && !current?.permissions.manageOwnHistory) return { denied: 'forbidden' as const };
  const allowed = current?.videos ?? null;
  const subjectKey = await deps.subjectKey();
  const conversation = input.conversationId ? { conversation_id: input.conversationId,
    resume_conversation: input.resumeConversation ?? false } : {};
  const ltiVideoGrant = allowed?.map(video => video.videoId);
  const usedScope = allowed ? await deps.recordScope(ltiVideoGrant!) : null;
  if (allowed && !usedScope) return { denied: 'expired' as const };
  const scopeChanged = usedScope?.some(id => !ltiVideoGrant!.includes(id));
  let messages = scopeChanged ? [input.messages.at(-1)!] : input.messages;
  if (input.playback) {
    const playback = input.playback;
    if (allowed ? !ltiVideoGrant!.includes(playback.videoId) : grant.videoId !== playback.videoId) return { denied: 'forbidden' as const };
    const course = await deps.course(ltiVideoGrant);
    if (!course?.memberVideoIds.includes(playback.videoId)) return { denied: 'forbidden' as const };
    const seconds = Math.floor(playback.seconds);
    const time = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map(value => String(value).padStart(2, '0')).join(':');
    const transcript = await deps.transcript(course.userId, course.memberVideoIds, playback.videoId);
    const cueHint = playbackCueHint(transcript, playback.seconds);
    const last = messages.at(-1)!;
    const contextual = deps.validateMessages([...messages.slice(0, -1), {
      role: 'user', content: `[視聴中の教材情報: 動画ID ${playback.videoId}、再生位置 ${time} (${seconds}秒)。「今の場面」「この説明」への質問では、この動画の字幕を確認し、再生位置を含む字幕区間を特定して、その区間の内容を中心に回答してください。${cueHint}]\n${last.content}`,
    }]);
    if (!contextual) return { denied: 'invalid' as const };
    messages = contextual;
  }
  return { messages, allowed, ltiVideoGrant, subjectKey, conversation };
}


export type AuthorizedLearningCourse = {
  current: CourseAccess; course: LearningCourse; grant: LearningGrant;
  reg: LtiRegistration; sessionHash: string;
};
export async function authorizeLearningCourse(access: LearningAuthorization, deps: {
  current(): Promise<CourseAccess | null>;
  course(videoIds: number[]): Promise<LearningCourse | null>;
}) {
  try {
    const current = await deps.current();
    if (!current) return { denied: true as const };
    const course = access.course ?? await deps.course([...current.videos, ...(current.managementVideos ?? [])].map(video => video.videoId));
    if (!course) return { denied: true as const };
    return { current, course, grant: access.grant, reg: access.reg, sessionHash: access.sessionHash };
  } catch { return { denied: true as const }; }
}

export const ownerLearningHistoryAvailable = (current: CourseAccess) => current.ownerHistory === true;

export async function readLearningTranscript(access: Pick<AuthorizedLearningCourse, 'current' | 'course'>,
  input: { videoId: number; cursor: number; limit: number },
  read: (ownerUserId: string, videoIds: number[], videoId: number) => Promise<VideoEvidence | null>,
) {
  const { videoId, cursor, limit } = input;
  const material = access.current.videos.find(video => video.videoId === videoId);
  if (!access.current.permissions.viewTranscript || !material || !access.course.memberVideoIds.includes(videoId)) return { denied: true as const };
  const video = await read(access.course.userId, [videoId], videoId);
  if (!video) return { denied: true as const };
  if (video.transcriptTooLarge) return { tooLarge: true as const };
  return { page: { videoId, title: material.title, ...transcriptPage(video.transcript, cursor, limit) } };
}

export async function readLearningHistory<Turn extends { logId: number | null }>(access: LearningAuthorization, deps: {
  current(): Promise<CourseAccess | null>;
  course(videoIds: number[] | undefined): Promise<LearningCourse | null>;
  turns(ownerUserId: string, videoIds: number[]): Promise<Turn[]>;
  feedback(logId: number | null): Promise<string | undefined>;
}) {
  let allowed;
  try { allowed = (await deps.current())?.videos ?? null; }
  catch { return { denied: true as const }; }
  const course = access.course ?? await deps.course(allowed?.map(video => video.videoId));
  if (!course) return { denied: true as const };
  const turns = await deps.turns(course.userId, course.memberVideoIds);
  return { turns: await Promise.all(turns.map(async ({ logId, ...turn }) => ({
    ...turn, feedbackId: await deps.feedback(logId),
  }))) };
}

export async function issueLearningFeedback(logId: number | null, deps: {
  newId(): string; save(id: string, logId: number): Promise<void>;
}): Promise<string | undefined> {
  if (logId === null) return undefined;
  const id = deps.newId();
  await deps.save(id, logId);
  return id;
}

export type LearningFeedbackReference = { sessionHash: string; courseId: number; logId: number };
export async function updateLearningFeedback<Throttle>(access: LearningAuthorization, feedbackId: string, feedback: 'good' | 'bad' | null, deps: {
  reference(id: string): Promise<LearningFeedbackReference | null>;
  current(): Promise<unknown>;
  course(): Promise<LearningCourse | null>;
  throttle(): Promise<Throttle | null>;
  update(logId: number, feedback: 'good' | 'bad' | null): ReturnType<ChatRepository['feedback']>;
}): Promise<{ denied: true } | { throttled: Throttle } | { feedback: 'good' | 'bad' | null }> {
  const ref = await deps.reference(feedbackId);
  if (!ref || ref.sessionHash !== access.sessionHash || ref.courseId !== access.grant.courseId) return { denied: true as const };
  try { await deps.current(); } catch { return { denied: true as const }; }
  if (!await deps.course()) return { denied: true as const };
  const throttle = await deps.throttle();
  if (throttle) return { throttled: throttle };
  const updated = await deps.update(ref.logId, feedback);
  if ('notFound' in updated || 'forbidden' in updated) return { denied: true as const };
  return { feedback: updated.feedback };
}

export async function completeLearningChat(question: string, logId: number | null, videoIds: number[] | undefined, deps: {
  append(question: string, logId: number | null, videoIds: number[] | undefined): Promise<void>;
  feedback(logId: number | null): Promise<string | undefined>;
}) {
  await deps.append(question, logId, videoIds);
  return deps.feedback(logId);
}
