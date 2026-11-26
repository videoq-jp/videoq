import { forbidden } from '../../application/errors';
import type {
  LearningGrant, LearningCourse, NativeLearningAccess, NativeLearningClaims,
  NativeLearningRegistration, NativeSessionInput,
} from '../../domain/lms/native-learning';

export interface NativeLearningDependencies<Registration, Access> {
  digest(value: string): Promise<string>;
  fingerprint(reg: Registration): Promise<string>;
  access(reg: Registration, grant: LearningGrant): Promise<Access | null>;
  loadCourse(courseId: number, videoIds: number[]): Promise<LearningCourse | null>;
  ensureSession(input: NativeSessionInput): Promise<void>;
}
const denied = () => forbidden('The LMS learning request is unavailable.');

/** Only verified assertions enter this workflow. Current authority is checked on every request. */
export function createNativeLearningService<Registration extends NativeLearningRegistration, Access extends NativeLearningAccess>(
  deps: NativeLearningDependencies<Registration, Access>,
) {
  return async (reg: Registration, claims: NativeLearningClaims) => {
    const binding = reg.resources.find(b => b.deploymentId === claims.deploymentId &&
      b.contextId === claims.contextId && b.resourceLinkId === claims.resourceLinkId);
    if (!binding || (!reg.materialsService && !claims.accessProof)) throw denied();
    const subjectHash = await deps.digest(JSON.stringify([reg.issuer, reg.clientId, claims.deploymentId, claims.subject]));
    const grant: LearningGrant = {
      ...(claims.author ? { moodleAuthor: { user_id: 'moodle:' + subjectHash, username: claims.author.name, email: claims.author.email } } : {}),
      transport: 'native', registrationId: reg.id, registrationHash: await deps.fingerprint(reg),
      deploymentId: claims.deploymentId, contextId: claims.contextId, resourceLinkId: claims.resourceLinkId,
      courseId: binding.courseId, subjectHash, roles: [], locale: claims.locale,
      ...(binding.videoId !== undefined ? { videoId: binding.videoId } : {}),
      ...(binding.generation !== undefined ? { resourceGeneration: binding.generation } : {}),
      ...(reg.materialsService ? { serviceSubject: claims.subject } :
        { accessProof: { token: claims.accessProof!, subject: claims.subject } }),
    };
    let current: Access | null;
    try { current = await deps.access(reg, grant); } catch { throw denied(); }
    if (!current) throw denied();
    const course = current.course ?? await deps.loadCourse(grant.courseId,
      [...current.videos, ...(current.managementVideos ?? [])].map(v => v.videoId));
    if (!course) throw denied();
    grant.scopeVideoIds = current.videos.map(v => v.videoId).sort((a, b) => a - b);
    const sessionHash = await deps.digest(JSON.stringify(['moodle-native-session-v1', reg.id, subjectHash,
      claims.contextId, claims.resourceLinkId, claims.sessionId]));
    await deps.ensureSession({
      ownerUserId: course.userId, grant, sessionHash,
      markerHash: await deps.digest(JSON.stringify(['moodle-native-session-started-v1', sessionHash])),
      nonceHash: await deps.digest(JSON.stringify(['moodle-native-request-v1', reg.id, claims.jti])),
      nonceExpiresAt: new Date((claims.exp + 60) * 1000), expiresAt: new Date(claims.sessionExpiresAt * 1000),
    });
    return { grant, reg, sessionHash, current, course };
  };
}
