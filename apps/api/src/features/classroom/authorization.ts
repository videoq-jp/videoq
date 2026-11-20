import { z } from 'zod';
import type { Bindings } from '../../types/bindings';
import { sessionRecord } from '../lti/protocol';
import { digest } from '../lti/store';
import { launchSchema, type ClassroomConfig } from './config';
export { classroomAccess, authorizeAttachment } from '../../integrations/classroom-authorization';
export { materialUri, attachmentMaterial } from './authorization-service';

export const classroomSession = sessionRecord.extend({ transport: z.literal('classroom'),
  classroom: z.object({ accountEnvelope: z.string(), launch: launchSchema, materialId: z.string() }),
});
export async function configFingerprint(env: Bindings, config: ClassroomConfig) {
  return digest(JSON.stringify([config, env.CLASSROOM_CLIENT_ID]));
}
