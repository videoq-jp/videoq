import { expect, it, vi } from 'vitest';
import { pairingCanReplay, matchingPairingPayload, pairingConnectionConflict, pairingExchangeAllowed, pairingExchangeFailure,
  pairingBooleanLogic, pairingProofMatches, validPairingAuthentication, pairingInstallationFields, pairingSyncTokenHash, pairingExpiry } from '../src/domain/lms/pairing-exchange';
import type { PairingExchangeInput } from '../src/domain/lms/moodle-pairing';

const input: PairingExchangeInput = { mode: 'materials', issuer: 'https://school.test', clientId: 'client', deploymentId: '2', secret: 'secret',
  materialsService: { tokenEndpoint: 'https://school.test/token', endpoint: 'https://school.test/materials' } };
it('replays only materials receipts for the exact platform identity', () => {
  const receipt = { issuer: input.issuer, clientId: input.clientId, deploymentId: input.deploymentId };
  expect(pairingCanReplay(input, receipt)).toBe(true);
  expect(pairingCanReplay({ ...input, mode: 'legacy' }, receipt)).toBe(false);
  expect(pairingCanReplay(input, null)).toBe(false);
  for (const key of ['issuer', 'clientId', 'deploymentId']) expect(pairingCanReplay(input, { ...receipt, [key]: 'other' })).toBe(false);
  const payload = { ownerUserId: 'owner', moodleUrl: input.issuer, mode: 'materials' as const };
  expect(matchingPairingPayload(payload, input)).toBe(payload);
  expect(matchingPairingPayload({ ...payload, mode: 'legacy' }, input)).toBeNull();
  expect(matchingPairingPayload({ ...payload, moodleUrl: 'https://other.test' }, input)).toBeNull();
});

it('permits same-owner reconnection only in materials mode', () => {
  expect(pairingConnectionConflict('materials', false, pairingBooleanLogic)).toBe(false);
  expect(pairingConnectionConflict('materials', true, pairingBooleanLogic)).toBe(true);
  expect(pairingConnectionConflict('legacy', false, pairingBooleanLogic)).toBe(true);
});

it('requires live code, owner and pointer without replay or connection conflict', () => {
  for (let bits = 0; bits < 32; bits++) {
    const facts = { code: Boolean(bits & 1), active: Boolean(bits & 2), pointer: Boolean(bits & 4), replay: Boolean(bits & 8), conflict: Boolean(bits & 16) };
    expect(pairingExchangeAllowed(facts, pairingBooleanLogic)).toBe(bits === 7);
  }
  const base = { replay: false, code: true, active: true, pointer: true, conflict: false };
  expect(pairingExchangeFailure({ ...base, replay: true, active: false, conflict: true })).toBe('INVALID_PAIRING_CODE');
  expect(pairingExchangeFailure({ ...base, code: false, active: false })).toBe('INVALID_PAIRING_CODE');
  expect(pairingExchangeFailure({ ...base, active: false, pointer: false, conflict: true })).toBe('INACTIVE_ACCOUNT');
  expect(pairingExchangeFailure({ ...base, pointer: false, conflict: true })).toBe('INVALID_PAIRING_CODE');
  expect(pairingExchangeFailure({ ...base, conflict: true })).toBe('CONNECTION_EXISTS');
  expect(pairingExchangeFailure(base)).toBeNull();
});

it('checks optional proof without hashing missing or malformed proof', async () => {
  const derive = vi.fn(async () => 'challenge');
  expect(await pairingProofMatches(undefined, undefined, derive)).toBe(true);
  expect(await pairingProofMatches(undefined, 'verifier', derive)).toBe(false);
  expect(await pairingProofMatches(1, 'verifier', derive)).toBe(false);
  expect(await pairingProofMatches('challenge', '', derive)).toBe(false);
  expect(derive).not.toHaveBeenCalled();
  expect(await pairingProofMatches('challenge', 'verifier', derive)).toBe(true);
  expect(await pairingProofMatches('wrong', 'verifier', derive)).toBe(false);
});

it('binds materials endpoints to the issuer path and keeps legacy authentication exclusive', () => {
  const origin = (endpoint: string, issuer: string) => new URL(endpoint).origin === new URL(issuer).origin;
  expect(validPairingAuthentication(input, origin)).toBe(true);
  expect(validPairingAuthentication({ ...input, syncToken: 'token' }, origin)).toBe(false);
  expect(validPairingAuthentication({ ...input, materialsService: { ...input.materialsService!, endpoint: 'https://school.test.evil/materials' } }, origin)).toBe(false);
  expect(validPairingAuthentication({ ...input, mode: 'legacy', materialsService: undefined, syncToken: 'token' }, origin)).toBe(true);
});

it('builds canonical Moodle endpoints and hashes only legacy sync secrets', async () => {
  expect(pairingInstallationFields(input)).toMatchObject({ name: input.issuer, authorizationUrl: input.issuer + '/mod/lti/auth.php', jwksUrl: input.issuer + '/mod/lti/certs.php' });
  const digest = vi.fn(async () => 'digest');
  expect(await pairingSyncTokenHash(input, digest)).toBeNull();expect(digest).not.toHaveBeenCalled();
  expect(await pairingSyncTokenHash({ ...input, mode: 'legacy', syncToken: 'token' }, digest)).toBe('digest');
  expect(digest).toHaveBeenCalledWith('token');expect(pairingExpiry(1000).getTime()).toBe(601000);
});
