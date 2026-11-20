/** Verified JWT data projected by the transport adapter. */
export interface LtiLaunchClaims {
  subject: string;
  nonce: unknown;
  authorizedParty: unknown;
  audience: unknown;
  messageType: unknown;
  version: unknown;
  target: unknown;
  deploymentId: string;
  contextId: string;
  resourceLinkId: string;
  roles: string[];
  locale: 'ja' | 'en';
  accessToken?: string;
}
export interface LtiLaunchRegistration {
  clientId: string;
  requiresAccessProof: boolean;
  serviceAuthority: boolean;
  resources: readonly {
    deploymentId: string; contextId: string; resourceLinkId: string;
    courseId: number; videoId?: number; generation?: number;
  }[];
}
export interface LtiLaunchLogin { nonce: string; target: string; deploymentHint?: string; }

export type LtiLoginRecord = {
  registrationId: string; nonce: string; browserHash: string; target: string;
  deploymentHint?: string; locale?: 'ja' | 'en';
};
