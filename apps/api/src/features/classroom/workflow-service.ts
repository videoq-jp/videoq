import { ClassroomAccessDeniedError } from '../../application/classroom';
import type { ClassroomLaunch, ClassroomMaterial } from '../../application/classroom';
import type { LearningGrant } from '../../application/native-learning';
import type { TeachingTicket } from '../../application/teaching';
import type { LearningMediaRepository } from '../../persistence/contracts/learning-media-repository';
import { classroomAccess, authorizeAttachment, materialUri, type ClassroomAuthorizationDependencies } from './authorization-service';
import { learningPlayback } from '../media/learning-playback-service';

export const classroomFeatures = { transcripts: true, qa: true, conversations: true, management: false, tags: false, reports: false };
export type ClassroomStoredSession = LearningGrant & { transport: 'classroom'; classroom: {
  accountEnvelope: string; launch: ClassroomLaunch; materialId: string;
} };
type SessionPayload = ClassroomStoredSession & { classroomAuthor: { user_id: string; username: string; email: string } };
export interface ClassroomWorkflowDependencies {
  authorization: ClassroomAuthorizationDependencies;
  newSecret(): string;
  digest(value: string): Promise<string>;
  encrypt(value: string, context: string): Promise<string>;
  decrypt(value: string, context: string): Promise<string>;
  loadSession(hash: string): Promise<ClassroomStoredSession | null>;
  saveSession(hash: string, session: SessionPayload, ttlSeconds: number): Promise<void>;
  issueTeachingTicket(input: TeachingTicket): Promise<{ url: string }>;
  createAttachment(launch: ClassroomLaunch, token: string, input: {
    title: string; teacherViewUri: { uri: string }; studentViewUri: { uri: string };
  }): Promise<{ id: string }>;
  playback: LearningMediaRepository['playback'];
  fileUrl(key: string): Promise<string | null>;
}

export function createClassroomWorkflowService(deps: ClassroomWorkflowDependencies) {
  async function catalog(launch: ClassroomLaunch, token: string) {
    const access = await classroomAccess(deps.authorization, launch, token);
    if (!access.context.teacherContext) throw new Error('Teacher required');
    if (!access.binding) return { ...access, materials: [] as ClassroomMaterial[] };
    const course = await deps.authorization.course({ courseId: access.binding.videoqCourseId, ltiCourseGrant: access.binding.videoqCourseId });
    if (!course) throw new Error('Course unavailable');
    const materials = access.binding.materials.filter(material => material.videoIds.every(id => course.memberVideoIds.includes(id)));
    return { ...access, materials };
  }
  async function attach(launch: ClassroomLaunch, token: string, materialId: string) {
    if (launch.view !== 'discovery') throw new Error('Discovery required');
    const access = await catalog(launch, token);
    const material = access.materials.find(material => material.id === materialId);
    if (!material) throw new Error('Material unavailable');
    const result = await deps.createAttachment(launch, access.account.accessToken, {
      title: material.title, teacherViewUri: { uri: materialUri(access.config, 'teacher', material.id) },
      studentViewUri: { uri: materialUri(access.config, 'student', material.id) },
    });
    return { attachmentId: result.id };
  }
  async function connectTeacher(launch: ClassroomLaunch, token: string) {
    if (launch.view === 'student') throw new Error('Teacher required');
    const access = await classroomAccess(deps.authorization, launch, token);
    if (!access.context.teacherContext) throw new Error('Teacher required');
    return deps.issueTeachingTicket({ provider: 'classroom', installationId: deps.authorization.clientId,
      contextId: launch.courseId, teacherSubject: access.account.subject,
      teacherName: access.account.name || access.account.email || access.account.subject,
      title: 'Classroom ' + launch.courseId, returnUrl: 'https://classroom.google.com/',
      classroomProof: { accountEnvelope: await deps.encrypt(token, 'teaching-classroom'), launch } });
  }
  async function prepareSession() {
    const token = deps.newSecret();
    return { token, sessionHash: await deps.digest(token) };
  }
  async function createSession(launch: ClassroomLaunch, accountToken: string, identity: { token: string; sessionHash: string }) {
    if (launch.view === 'discovery') throw new Error('Attachment required');
    const { token, sessionHash } = identity;
    const access = await authorizeAttachment(deps.authorization, launch, accountToken, sessionHash);
    await deps.saveSession(sessionHash, { ...access.grant, transport: 'classroom', classroomAuthor: access.classroomAuthor, classroom: {
      launch, materialId: access.materialId,
      accountEnvelope: await deps.encrypt(accountToken, `classroom-session:${sessionHash}`),
    } }, 3600);
    return { token, materialTitle: access.materialTitle, expiresIn: 3600, features: classroomFeatures, learningAvailable: access.current!.videos.length > 0,
      ...(access.current!.videos.length ? { playback: { videoId: access.current!.videos[0].videoId, videos: access.current!.videos, parentOrigins: [] } } : {}) };
  }
  async function authorize(token: string) {
    const sessionHash = await deps.digest(token);
    const stored = await deps.loadSession(sessionHash);
    if (!stored) return { failure: 'unauthorized' } as const;
    try {
      const config = deps.authorization.config();
      if (!config || stored.registrationHash !== await deps.authorization.fingerprint(config)) return { failure: 'forbidden' } as const;
      const accountToken = await deps.decrypt(stored.classroom.accountEnvelope, `classroom-session:${sessionHash}`);
      const access = await authorizeAttachment(deps.authorization, stored.classroom.launch, accountToken, sessionHash);
      if (access.materialId !== stored.classroom.materialId || access.grant.subjectHash !== stored.subjectHash || access.grant.courseId !== stored.courseId)
        return { failure: 'forbidden' } as const;
      // Retain accumulated scope so the shared chat workflow detects shrinkage.
      return { access: { ...access, grant: { ...access.grant, scopeVideoIds: stored.scopeVideoIds } } };
    } catch { return { failure: 'forbidden' } as const; }
  }
  async function playback(access: Awaited<ReturnType<typeof authorizeAttachment>>, videoId: number) {
    const result = await learningPlayback(deps, access, videoId);
    if (!result) throw new ClassroomAccessDeniedError('Video unavailable');
    return result;
  }
  return { catalog, attach, connectTeacher, prepareSession, createSession, authorize, playback };
}
