import { z } from 'zod';
import { teachingConnection } from '../teaching/service';
import type { ClassroomCourse } from './config';
import type { Bindings } from '../../types/bindings';
import { getCourseWithMembers } from '../../repositories/chat-repository';
import { classroomVideoSummaries } from './repository';
import { sessionRecord } from '../lti/protocol';
import { digest } from '../lti/store';
import { ltiSubjectKey } from '../lti/identity';
import { deniedCoursePermissions } from '../lti/course-permissions';
import type { LearningAuthorization } from '../lti/session-authorization';
import type { LtiRegistration } from '../lti/config';
import { classroomConfig, launchSchema, type ClassroomConfig, type ClassroomLaunch } from './config';
import { getAttachment, getContext } from './client';
import { readAccount } from './oauth';

export const classroomSession = sessionRecord.extend({ transport: z.literal('classroom'),
  classroom: z.object({ accountEnvelope: z.string(), launch: launchSchema, materialId: z.string() }),
});
export async function configFingerprint(env: Bindings, config: ClassroomConfig) {
  return digest(JSON.stringify([config, env.CLASSROOM_CLIENT_ID]));
}
export function materialUri(config: ClassroomConfig, view: 'teacher' | 'student', materialId: string) {
  return `${config.toolOrigin}/api/classroom/${view}?material=${encodeURIComponent(materialId)}`;
}
/** Derive the material from Google's attachment, never from an editable launch URL. */
export function attachmentMaterial(config: ClassroomConfig, course: ClassroomCourse, attachment: Awaited<ReturnType<typeof getAttachment>>) {
  return course?.materials.find(material => attachment.studentViewUri.uri === materialUri(config, 'student', material.id)
    && attachment.teacherViewUri.uri === materialUri(config, 'teacher', material.id));
}
export async function classroomAccess(env: Bindings, launch: ClassroomLaunch, accountToken: string) {
  const config = classroomConfig(env);
  if (!config) throw new Error('Classroom unavailable');
  const account = await readAccount(env, accountToken);
  if (launch.login_hint && launch.login_hint !== account.subject) throw new Error('Google account mismatch');
  const context = await getContext(launch, account.accessToken);
  const connection = await teachingConnection(env, 'classroom', env.CLASSROOM_CLIENT_ID!, launch.courseId);
  let binding: ClassroomCourse | null = null;
  if (connection) {
    const course = await getCourseWithMembers(env, { courseId: connection.courseId, userId: connection.ownerUserId });
    if (course && course.userId === connection.ownerUserId) binding = { classroomCourseId: launch.courseId, videoqCourseId: course.id,
      materials: [{ id: connection.id, title: connection.courseTitle, videoIds: course.memberVideoIds }] };
  }
  return { config, binding, account, context, connection };
}
export async function authorizeAttachment(env: Bindings, launch: ClassroomLaunch, accountToken: string, sessionHash: string): Promise<LearningAuthorization & { materialId: string; materialTitle: string; classroomAuthor: { user_id: string; username: string; email: string } }> {
  if (launch.view === 'discovery') throw new Error('Attachment required');
  const { config, binding, account, context, connection } = await classroomAccess(env, launch, accountToken);
  if (!binding) throw new Error('This class is not connected by its teacher');
  const attachment = await getAttachment(launch, account.accessToken);
  const material = attachmentMaterial(config, binding, attachment);
  if (!material) throw new Error('Attachment material is not connected');
  const course = await getCourseWithMembers(env, { courseId: binding.videoqCourseId, ltiCourseGrant: binding.videoqCourseId,
    ltiVideoGrant: material.videoIds });
  if (!course || material.videoIds.some(id => !course.memberVideoIds.includes(id))) throw new Error('Material was removed');
  const available = await classroomVideoSummaries(env, course.userId, material.videoIds);
  const videos = material.videoIds.flatMap(id => {
    const video = available.find(video => video.id === id);
    return video ? [{ videoId: video.id, lesson: String(video.id), title: video.title || material.title }] : [];
  });
  const registrationId = 'classroom:' + launch.courseId;
  const registrationHash = await configFingerprint(env, config);
  const reg: LtiRegistration = { id: registrationId, issuer: 'https://accounts.google.com', clientId: env.CLASSROOM_CLIENT_ID!,
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth', jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    frameOrigins: ['https://classroom.google.com'], resources: [] };
  const subjectHash = await digest(JSON.stringify(['classroom', env.CLASSROOM_CLIENT_ID, account.subject]));
  const studentId = 'classroom:' + await ltiSubjectKey({ registrationId, subjectHash });
  return { classroomAuthor: { user_id: studentId, username: account.name || account.email || studentId, email: account.email || '' }, materialId: material.id, materialTitle: material.title, reg, sessionHash, course,
    grant: { transport: 'classroom', registrationId, registrationHash, deploymentId: env.CLASSROOM_CLIENT_ID!,
      contextId: launch.courseId, resourceLinkId: JSON.stringify([launch.itemType, launch.itemId, launch.attachmentId]),
      subjectHash,
      courseId: binding.videoqCourseId, scopeVideoIds: videos.map(video => video.videoId), locale: 'ja',
      roles: [context.teacherContext ? 'teacher' : 'student'] },
    current: { ownerHistory: !!context.teacherContext && connection?.teacherSubject === account.subject, videos, permissions: { ...deniedCoursePermissions, manageOwnHistory: true, viewTranscript: true,
      viewQa: true, postQa: true, voteQa: true, deleteOwnQa: true,
      moderateQa: !!context.teacherContext, instructorQa: !!context.teacherContext } },
  };
}
