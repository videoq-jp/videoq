import type { ClassroomConfig, ClassroomCourse, ClassroomLaunch, ClassroomAccount, ClassroomContext, ClassroomAttachment } from '../../application/classroom';
import type { LearningAuthorization } from '../../application/lti-authorization';
import type { LtiRegistration } from '../../application/lti-registration';
import { deniedCoursePermissions } from '../../application/lms-authority';
import type { TeachingConnection } from '../../persistence/contracts/teaching-repository';
import type { ChatRepository } from '../../persistence/contracts/chat-repository';
import type { LearningMediaRepository } from '../../persistence/contracts/learning-media-repository';

export interface ClassroomAuthorizationDependencies {
  clientId: string;
  config(): ClassroomConfig | null;
  account(token: string): Promise<ClassroomAccount>;
  context(launch: ClassroomLaunch, token: string): Promise<ClassroomContext>;
  connection(courseId: string): Promise<TeachingConnection | null>;
  course: ChatRepository['context'];
  attachment(launch: ClassroomLaunch, token: string): Promise<ClassroomAttachment>;
  summaries: LearningMediaRepository['summaries'];
  fingerprint(config: ClassroomConfig): Promise<string>;
  digest(value: string): Promise<string>;
  subjectKey(value: { registrationId: string; subjectHash: string }): Promise<string>;
}

export function materialUri(config: ClassroomConfig, view: 'teacher' | 'student', materialId: string) {
  return `${config.toolOrigin}/api/classroom/${view}?material=${encodeURIComponent(materialId)}`;
}
/** Derive the material from Google's attachment, never from an editable launch URL. */
export function attachmentMaterial(config: ClassroomConfig, course: ClassroomCourse, attachment: ClassroomAttachment) {
  return course?.materials.find(material => attachment.studentViewUri.uri === materialUri(config, 'student', material.id)
    && attachment.teacherViewUri.uri === materialUri(config, 'teacher', material.id));
}
export async function classroomAccess(deps: ClassroomAuthorizationDependencies, launch: ClassroomLaunch, accountToken: string) {
  const config = deps.config();
  if (!config) throw new Error('Classroom unavailable');
  const account = await deps.account(accountToken);
  if (launch.login_hint && launch.login_hint !== account.subject) throw new Error('Google account mismatch');
  const context = await deps.context(launch, account.accessToken);
  const connection = await deps.connection(launch.courseId);
  let binding: ClassroomCourse | null = null;
  if (connection) {
    const course = await deps.course({ courseId: connection.courseId, userId: connection.ownerUserId });
    if (course && course.userId === connection.ownerUserId) binding = { classroomCourseId: launch.courseId, videoqCourseId: course.id,
      materials: [{ id: connection.id, title: connection.courseTitle, videoIds: course.memberVideoIds }] };
  }
  return { config, binding, account, context, connection };
}
export async function authorizeAttachment(deps: ClassroomAuthorizationDependencies, launch: ClassroomLaunch, accountToken: string, sessionHash: string): Promise<LearningAuthorization & { materialId: string; materialTitle: string; classroomAuthor: { user_id: string; username: string; email: string } }> {
  if (launch.view === 'discovery') throw new Error('Attachment required');
  const { config, binding, account, context, connection } = await classroomAccess(deps, launch, accountToken);
  if (!binding) throw new Error('This class is not connected by its teacher');
  const attachment = await deps.attachment(launch, account.accessToken);
  const material = attachmentMaterial(config, binding, attachment);
  if (!material) throw new Error('Attachment material is not connected');
  const course = await deps.course({ courseId: binding.videoqCourseId, ltiCourseGrant: binding.videoqCourseId,
    ltiVideoGrant: material.videoIds });
  if (!course || material.videoIds.some(id => !course.memberVideoIds.includes(id))) throw new Error('Material was removed');
  const available = await deps.summaries(course.userId, material.videoIds);
  const videos = material.videoIds.flatMap(id => {
    const video = available.find(video => video.id === id);
    return video ? [{ videoId: video.id, lesson: String(video.id), title: video.title || material.title }] : [];
  });
  const registrationId = 'classroom:' + launch.courseId;
  const registrationHash = await deps.fingerprint(config);
  const reg: LtiRegistration = { id: registrationId, issuer: 'https://accounts.google.com', clientId: deps.clientId,
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth', jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    frameOrigins: ['https://classroom.google.com'], resources: [] };
  const subjectHash = await deps.digest(JSON.stringify(['classroom', deps.clientId, account.subject]));
  const studentId = 'classroom:' + await deps.subjectKey({ registrationId, subjectHash });
  return { classroomAuthor: { user_id: studentId, username: account.name || account.email || studentId, email: account.email || '' }, materialId: material.id, materialTitle: material.title, reg, sessionHash, course,
    grant: { transport: 'classroom', registrationId, registrationHash, deploymentId: deps.clientId,
      contextId: launch.courseId, resourceLinkId: JSON.stringify([launch.itemType, launch.itemId, launch.attachmentId]),
      subjectHash,
      courseId: binding.videoqCourseId, scopeVideoIds: videos.map(video => video.videoId), locale: 'ja',
      roles: [context.teacherContext ? 'teacher' : 'student'] },
    current: { ownerHistory: !!context.teacherContext && connection?.teacherSubject === account.subject, videos, permissions: { ...deniedCoursePermissions, manageOwnHistory: true, viewTranscript: true,
      viewQa: true, postQa: true, voteQa: true, deleteOwnQa: true,
      moderateQa: !!context.teacherContext, instructorQa: !!context.teacherContext } },
  };
}
