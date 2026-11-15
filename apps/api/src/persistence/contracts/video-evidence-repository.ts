/** Scope is captured from setupChat, never supplied by the model. */
export type EvidenceScope = { ownerUserId: string; videoIds: readonly number[] };

export type VideoEvidence = {
 id: number;title: string;sourceType: string;fileKey: string;transcript: string|null;transcriptTooLarge: boolean;visualRunId?: string|null;visualManifestVersion?:string|null;
};
export interface VideoEvidenceRepository {
 getEvidence(scope: EvidenceScope,videoId: number): Promise<VideoEvidence|null>;
}
