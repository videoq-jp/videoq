import { classroomConfig } from '../features/classroom/config';
import { getContext } from '../features/classroom/client';
import { readAccount } from '../features/classroom/oauth';
import { decryptServerSecret } from '../lib/secret-encryption';
import { ltiConfig } from '../features/lti/config';
import { MaterialsClient } from '../features/lms/connector-client';
import { ApiError } from '../shared/errors';
import type { Bindings } from '../types/bindings';
import { digest, putCredential, randomSecret, readCredential } from '../features/lti/store';

import {ticketSchema,type TeachingTicket} from '../shared/teaching';

import {createTeachingRepository} from '../persistence/factory';
import { createTeachingService } from '../features/teaching/core';

const denied = () => new ApiError(403, 'FORBIDDEN', 'The teaching connection is unavailable.');

function service(env: Bindings) {
  return createTeachingService({
    randomTicket: randomSecret,
    digest,
    validateTicket(input) {
      const parsed = ticketSchema.safeParse(input);
      if (!parsed.success) throw denied();
      return parsed.data;
    },
    saveTicket: (id, input, ttl) => putCredential(env, id, 'teaching-connect', { ...input }, ttl),
    loadTicket: id => readCredential(env, id, 'teaching-connect'),
    connectionUrl(ticket) {
      const frontend = new URL(env.FRONTEND_URL);
      if (frontend.protocol !== 'https:') throw denied();
      return frontend.origin + '/teaching/connect?ticket=' + ticket;
    },
    verifyAuthority: input => verifyTeachingAuthority(env, input),
    connect: async (...args) => (await createTeachingRepository(env)).connect(...args),
  });
}
export function issueTeachingTicket(env: Bindings, input: TeachingTicket) {
  return service(env).issueTeachingTicket(ticketSchema.parse(input));
}
export function readTeachingTicket(env: Bindings, ticket: string) {
  return service(env).readTeachingTicket(ticket);
}
export function connectTeachingCourse(env: Bindings, ticket: string, ownerUserId: string, selectedCourseId?: number) {
  return service(env).connectTeachingCourse(ticket, ownerUserId, selectedCourseId);
}
export async function teachingConnection(env: Bindings, provider: 'moodle' | 'classroom', installationId: string, contextId: string) {
  return (await createTeachingRepository(env)).findConnection(provider, installationId, contextId);
}

async function verifyTeachingAuthority(env: Bindings, input: TeachingTicket) {
  if (input.provider === 'classroom') {
    if (!classroomConfig(env) || !input.classroomProof || input.installationId !== env.CLASSROOM_CLIENT_ID) throw denied();
    const account = await readAccount(env, await decryptServerSecret(env, input.classroomProof.accountEnvelope, 'teaching-classroom'));
    if (account.subject !== input.teacherSubject || input.classroomProof.launch.courseId !== input.contextId) throw denied();
    const context = await getContext(input.classroomProof.launch, account.accessToken);
    if (!context.teacherContext) throw denied();
  } else {
    if (!ltiConfig(env)?.databaseRegistrations) throw denied();
    const site=await (await createTeachingRepository(env)).findInstallation(input.installationId);
    if (!site?.materialsService || !input.resourceLinkId) throw denied();
    const context = await new MaterialsClient(env, { ...site, materialsService: site.materialsService })
      .access(input.contextId, input.resourceLinkId, input.teacherSubject);
    if (!context.permissions?.manageContent) throw denied();
  }
}
