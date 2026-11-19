import type { LtiSessionProof } from "../../application/lti-session-proof";

export type LtiDataSubject = { subjectKey: string; resourceVideoIds: number[]; sessionProof?: LtiSessionProof };
