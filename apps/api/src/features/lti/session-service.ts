import type { LtiRegistration } from '../../domain/lms/lti-registration';
import type { LtiLoginRecord } from '../../domain/lms/lti-launch';
import type { LearningGrant, LearningCourse } from '../../domain/lms/native-learning';
import type { CourseAccess } from '../../domain/lms/lms-authority';
import { learningFeatures } from '../../domain/lms/learning-features';
import type { authorizeLtiLaunch } from './launch-service';

type VerifiedLaunch = ReturnType<typeof authorizeLtiLaunch>;
export interface LtiSessionDependencies {
  loadLogin(state: string): Promise<LtiLoginRecord | null>;
  loadSession(hash: string): Promise<LearningGrant | null>;
  saveLogin(state: string, login: LtiLoginRecord, seconds: number): Promise<void>;
  saveSession(hash: string, grant: LearningGrant, seconds: number): Promise<void>;
  consumeLogin(state: string): Promise<boolean>;
  newSecret(): string;
  digest(value: string): Promise<string>;
  fingerprint(reg: LtiRegistration): Promise<string>;
  verify(token: string, reg: LtiRegistration, login: LtiLoginRecord): Promise<VerifiedLaunch>;
  course(id: number): Promise<LearningCourse | null>;
  access(reg: LtiRegistration, grant: VerifiedLaunch): Promise<CourseAccess | null>;
}

export async function initiateLtiLogin(deps: LtiSessionDependencies, registrations: LtiRegistration[], target: string, input: {
  issuer: string; clientId?: string; loginHint?: string; target: string; deploymentHint?: string; messageHint?: string; locale: 'ja' | 'en';
}) {
  const candidates = registrations.filter(reg => reg.issuer === input.issuer && (!input.clientId || reg.clientId === input.clientId));
  if (candidates.length !== 1 || !input.loginHint || input.target !== target) return null;
  const reg = candidates[0], deploymentHint = input.deploymentHint;
  if (deploymentHint && reg.deploymentId !== deploymentHint && !reg.resources.some(item => item.deploymentId === deploymentHint)) return null;
  const state = deps.newSecret(), nonce = deps.newSecret(), browserSecret = deps.newSecret();
  await deps.saveLogin(state, { registrationId: reg.id, locale: input.locale, nonce, browserHash: await deps.digest(browserSecret), target, deploymentHint }, 300);
  return { reg, state, nonce, browserSecret, target, loginHint: input.loginHint, messageHint: input.messageHint, deploymentHint };
}

export async function exchangeLtiLogin(deps: LtiSessionDependencies, registrations: LtiRegistration[], input: { state: string; browserSecret: string; idToken: string }) {
  const login = await deps.loadLogin(input.state);
  if (!login || login.browserHash !== await deps.digest(input.browserSecret)) return { ok: false, failure: 'unauthorized' } as const;
  const reg = registrations.find(item => item.id === login.registrationId);
  if (!reg) return { ok: false, failure: 'unauthorized' } as const;
  let launch: VerifiedLaunch;
  try { launch = await deps.verify(input.idToken, reg, login); }
  catch { return { ok: false, failure: 'unauthorized' } as const; }
  const course = await deps.course(launch.courseId);
  if (!course || (launch.videoId !== undefined && !course.memberVideoIds.includes(launch.videoId))) return { ok: false, failure: 'forbidden' } as const;
  let current: CourseAccess | null;
  try { current = await deps.access(reg, launch); }
  catch { return { ok: false, failure: 'forbidden' } as const; }
  const allowed = current?.videos ?? null;
  const playbackVideoId = launch.videoId ?? allowed?.[0]?.videoId;
  if (launch.videoId && current && ![...current.videos, ...(current.managementVideos ?? [])].some(video => video.videoId === launch.videoId)) return { ok: false, failure: 'forbidden' } as const;
  if (!await deps.consumeLogin(input.state)) return { ok: false, failure: 'unauthorized' } as const;
  const token = deps.newSecret();
  const { subject, ...grant } = launch;
  await deps.saveSession(await deps.digest(token), {
    ...grant, ...(allowed ? { scopeVideoIds: allowed.map(video => video.videoId).sort((a, b) => a - b) } : {}),
    registrationId: reg.id, registrationHash: await deps.fingerprint(reg),
    subjectHash: await deps.digest(JSON.stringify([reg.issuer, reg.clientId, grant.deploymentId, subject])),
  }, 3600);
  return { ok: true, value: { token, expiresIn: 3600, learningAvailable: !current || current.videos.length > 0,
    features: learningFeatures(reg, grant),
    ...(playbackVideoId ? { playback: { videoId: playbackVideoId, parentOrigins: reg.frameOrigins, ...(allowed ? { videos: allowed } : {}) } } : {}),
  } } as const;
}

export async function authorizeLtiSession(deps: LtiSessionDependencies, registrations: LtiRegistration[], token: string) {
  const hash = await deps.digest(token), grant = await deps.loadSession(hash);
  if (!grant || grant.transport !== undefined) return { ok: false, failure: 'unauthorized' } as const;
  const reg = registrations.find(item => item.id === grant.registrationId);
  if (!reg || grant.registrationHash !== await deps.fingerprint(reg) || !reg.resources.some(item => item.deploymentId === grant.deploymentId && item.contextId === grant.contextId
    && item.resourceLinkId === grant.resourceLinkId && item.courseId === grant.courseId
    && item.videoId === grant.videoId && item.generation === grant.resourceGeneration)) return { ok: false, failure: 'forbidden' } as const;
  return { ok: true, value: { grant, reg, sessionHash: hash } } as const;
}
