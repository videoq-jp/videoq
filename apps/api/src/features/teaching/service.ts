import { classroomConfig } from '../classroom/config';
import { getContext } from '../classroom/client';
import { readAccount } from '../classroom/oauth';
import { decryptServerSecret } from '../../lib/secret-encryption';
import { ltiConfig } from '../lti/config';
import { MaterialsClient } from '../lms/connector-client';
import { ApiError } from '../../shared/errors';
import type { Bindings } from '../../types/bindings';
import { digest, putCredential, randomSecret, readCredential } from '../lti/store';

import {ticketSchema,type TeachingTicket} from '../../shared/teaching';
export {ticketSchema,type TeachingTicket} from '../../shared/teaching';
import {createTeachingRepository} from '../../persistence/factory';
const denied = () => new ApiError(403, 'FORBIDDEN', 'The teaching connection is unavailable.');
export async function issueTeachingTicket(env: Bindings, input: TeachingTicket) {
  const ticket = randomSecret();
  await putCredential(env, await digest(ticket), 'teaching-connect', ticketSchema.parse(input), 600);
  const frontend = new URL(env.FRONTEND_URL);
  if (frontend.protocol !== 'https:') throw denied();
  return { url: frontend.origin + '/teaching/connect?ticket=' + ticket };
}
export async function teachingConnection(env: Bindings, provider: 'moodle' | 'classroom', installationId: string, contextId: string) {
  return (await createTeachingRepository(env)).findConnection(provider,installationId,contextId);
}
export async function readTeachingTicket(env:Bindings,ticket:string){
 const input=ticketSchema.safeParse(await readCredential(env,await digest(ticket),'teaching-connect'));
 if(!input.success)throw denied();return input.data;
}
/** Recheck external teacher authority before atomically consuming the ticket. */
export async function connectTeachingCourse(env:Bindings,ticket:string,ownerUserId:string,selectedCourseId?:number){
 const authority=await readTeachingTicket(env,ticket);
 await verifyTeachingAuthority(env,authority);
 return (await createTeachingRepository(env)).connect(await digest(ticket),ownerUserId,authority,selectedCourseId);
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
