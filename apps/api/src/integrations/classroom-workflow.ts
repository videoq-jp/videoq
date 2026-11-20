import { createClassroomWorkflowService } from '../features/classroom/workflow-service';
import { classroomAuthorizationDependencies } from './classroom-authorization';
import { classroomSession } from '../features/classroom/authorization';
import { attachmentSchema, googleJson, postUrl } from '../features/classroom/client';
import { issueTeachingTicket } from '../features/teaching/service';
import { classroomPlaybackVideo } from '../features/classroom/repository';
import { randomSecret, digest, putCredential, readCredential } from '../features/lti/store';
import { encryptServerSecret, decryptServerSecret } from '../lib/secret-encryption';
import { resolveFileUrl } from './media';
import type { Bindings } from '../types/bindings';

export function classroomWorkflow(env: Bindings) {
  return createClassroomWorkflowService({
    authorization: classroomAuthorizationDependencies(env), newSecret: randomSecret, digest,
    encrypt: (value, context) => encryptServerSecret(env, value, context),
    decrypt: (value, context) => decryptServerSecret(env, value, context),
    loadSession: async hash => { const value = classroomSession.safeParse(await readCredential(env, hash, 'session')); return value.success ? value.data : null; },
    saveSession: (hash, session, ttl) => putCredential(env, hash, 'session', session, ttl),
    issueTeachingTicket: input => issueTeachingTicket(env, input),
    createAttachment: async (launch, token, input) => {
      const url = postUrl(launch, 'addOnAttachments'); url.searchParams.set('addOnToken', launch.addOnToken!);
      return attachmentSchema.parse(await googleJson(url, token, input));
    },
    playback: (owner, id) => classroomPlaybackVideo(env, owner, id), fileUrl: key => resolveFileUrl(env, key),
  });
}
