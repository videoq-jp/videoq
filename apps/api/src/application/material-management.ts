import type { LtiSessionProof } from './lti-session-proof';
export type { MaterialCommand, MaterialView, ManagedVideo, MaterialJob, ReadableManagedVideo, MaterialTranscriptionMessage } from '../domain/media/material-model';
export type ManagedMaterialScope = {
  installationId: string; ownerUserId: string; courseId: number; contextId: string;
  resourceLinkId: string; videoId: number; generation: number; actorKey: string;
  sessionProof?: LtiSessionProof;
};
