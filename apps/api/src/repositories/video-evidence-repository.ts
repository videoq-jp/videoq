import type { Bindings } from "../types/bindings";
import type { EvidenceScope } from "../persistence/contracts/video-evidence-repository";
import { createVideoEvidenceRepository } from "../persistence/factory";
export type { EvidenceScope } from "../persistence/contracts/video-evidence-repository";

export async function getVideoEvidence(env: Bindings,scope: EvidenceScope,videoId: number) {
 return (await createVideoEvidenceRepository(env)).getEvidence(scope,videoId);
}
