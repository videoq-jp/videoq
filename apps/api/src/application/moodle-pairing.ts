/** Application data independent of connector schemas and runtime bindings. */
export const PAIRING_SECONDS = 600;
export type PairingMode = 'legacy' | 'materials';
export type PairingCodePayload = { ownerUserId: string; moodleUrl: string; mode: PairingMode; codeChallenge?: string };
export type PairingExchangeInput = {
  secret: string; issuer: string; clientId: string; deploymentId: string;
  mode: PairingMode; syncToken?: string; codeVerifier?: string;
  materialsService?: { tokenEndpoint: string; endpoint: string };
};
export type PairingSettings = {
  installationId: string; toolOrigin: string;
  uploadTargets: { origin: string; prefix: string }[];
};
