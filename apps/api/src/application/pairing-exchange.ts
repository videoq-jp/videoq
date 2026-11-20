import { PAIRING_SECONDS, type PairingMode, type PairingCodePayload, type PairingExchangeInput } from './moodle-pairing';

export function pairingMaterialsUnavailable(mode: PairingMode, enabled: boolean): boolean {
  return mode === 'materials' && !enabled;
}
export function pairingSupportsReplay(mode: PairingMode): boolean { return mode === 'materials'; }

export function pairingCanReplay(input: PairingExchangeInput, receipt: Record<string, unknown> | null | undefined): boolean {
  return pairingSupportsReplay(input.mode) && receipt?.issuer === input.issuer && receipt.clientId === input.clientId
    && receipt.deploymentId === input.deploymentId;
}

export function matchingPairingPayload(payload: PairingCodePayload | null, input: PairingExchangeInput): PairingCodePayload | null {
  return payload?.moodleUrl === input.issuer && payload.mode === input.mode ? payload : null;
}

export async function pairingProofMatches(challenge: unknown, verifier: string | undefined,
  deriveChallenge: (value: string) => Promise<string>): Promise<boolean> {
  return challenge === undefined ? verifier === undefined
    : typeof challenge === 'string' && Boolean(verifier) && await deriveChallenge(verifier!) === challenge;
}

export function validPairingAuthentication(input: Pick<PairingExchangeInput, 'mode' | 'syncToken' | 'materialsService' | 'issuer'>,
  sameOrigin: (endpoint: string, issuer: string) => boolean): boolean {
  return input.mode === 'materials' ? input.syncToken === undefined && Boolean(input.materialsService)
    && Object.values(input.materialsService!).every(endpoint => endpoint.startsWith(input.issuer + '/') && sameOrigin(endpoint, input.issuer))
    : Boolean(input.syncToken) && input.materialsService === undefined;
}

export interface PairingLogic<Value, Predicate> {
  modeIsNot(mode: Value, expected: 'materials'): Predicate;
  and(...terms: Predicate[]): Predicate;
  or(left: Predicate, right: Predicate): Predicate;
  not(term: Predicate): Predicate;
}

export function pairingConnectionConflict<Value, Predicate>(mode: Value, ownerDiffers: Predicate,
  logic: Pick<PairingLogic<Value, Predicate>, 'modeIsNot' | 'or'>): Predicate {
  return logic.or(logic.modeIsNot(mode, 'materials'), ownerDiffers);
}

export function pairingExchangeAllowed<Predicate>(facts: {
  code: Predicate; active: Predicate; pointer: Predicate; replay: Predicate; conflict: Predicate;
}, logic: Pick<PairingLogic<unknown, Predicate>, 'and' | 'not'>): Predicate {
  return logic.and(facts.code, facts.active, facts.pointer, logic.not(facts.replay), logic.not(facts.conflict));
}

export type PairingFailure = 'INVALID_PAIRING_CODE' | 'INACTIVE_ACCOUNT' | 'CONNECTION_EXISTS';
/** Only call after a failed atomic exchange, preserving the public failure order. */
export function pairingExchangeFailure(state: { replay: boolean; code: boolean; active: boolean; pointer: boolean; conflict: boolean }): PairingFailure | null {
  if (state.replay || !state.code) return 'INVALID_PAIRING_CODE';
  if (!state.active) return 'INACTIVE_ACCOUNT';
  if (!state.pointer) return 'INVALID_PAIRING_CODE';
  if (state.conflict) return 'CONNECTION_EXISTS';
  return null;
}

export function pairingInstallationFields(input: PairingExchangeInput) {
  return { name: input.issuer, issuer: input.issuer, clientId: input.clientId, deploymentId: input.deploymentId,
    authorizationUrl: input.issuer + '/mod/lti/auth.php', jwksUrl: input.issuer + '/mod/lti/certs.php' };
}
export function pairingExpiry(nowMs: number): Date { return new Date(nowMs + PAIRING_SECONDS * 1000); }
export function pairingSyncTokenHash(input: PairingExchangeInput, digest: (value: string) => Promise<string>): Promise<string | null> {
  return input.mode === 'materials' ? Promise.resolve(null) : digest(input.syncToken!);
}

export const pairingBooleanLogic: PairingLogic<PairingMode, boolean> = {
  modeIsNot: (mode, expected) => mode !== expected,
  and: (...terms) => terms.every(Boolean), or: (left, right) => left || right, not: term => !term,
};
