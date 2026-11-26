import { expect, it, vi } from 'vitest';
import { authorizePrivacyRequest, type PrivacyAuthorizationDependencies } from '../src/features/lms/privacy-authorization-service';
import type { PrivacyAssertionClaims } from '../src/domain/lms/privacy';

const installation = { id: 'school', ownerUserId: 'owner', issuer: 'https://school.test', clientId: 'client', deploymentId: 'dep', jwksUrl: 'https://school.test/keys' };
const claims: PrivacyAssertionClaims = { iss: installation.issuer, sub: 'client', deploymentId: 'dep', aud: 'https://tool.test/api/lms/privacy', exp: 100, jti: 'nonce', request: { action: 'catalog' } };
function fixture() {
  const repository = { findInstallation: vi.fn().mockResolvedValue(installation), consumeNonce: vi.fn().mockResolvedValue(true) };
  const deps = { enabled: true, toolOrigin: 'https://tool.test', hint: vi.fn().mockReturnValue(claims), verify: vi.fn().mockResolvedValue(claims),
    repository: vi.fn().mockResolvedValue(repository), digest: vi.fn().mockResolvedValue('hash') } satisfies PrivacyAuthorizationDependencies;
  return { deps, repository };
}
it('does not access persistence for invalid hints or a disabled service', async () => {
  const { deps } = fixture();
  deps.hint.mockImplementation(() => { throw new Error('malformed'); });
  await expect(authorizePrivacyRequest(deps, 'assertion')).rejects.toMatchObject({ kind: 'forbidden' });
  expect(deps.repository).not.toHaveBeenCalled();
  deps.enabled = false;
  await expect(authorizePrivacyRequest(deps, 'assertion')).rejects.toMatchObject({ kind: 'unavailable', code: 'PRIVACY_UNAVAILABLE' });
});
it('never verifies unknown registrations or consumes nonces for a mismatched audience', async () => {
  const { deps, repository } = fixture();
  repository.findInstallation.mockResolvedValue(null);
  await expect(authorizePrivacyRequest(deps, 'assertion')).rejects.toMatchObject({ kind: 'forbidden' });
  expect(deps.verify).not.toHaveBeenCalled();
  repository.findInstallation.mockResolvedValue(installation);
  deps.verify.mockResolvedValue({ ...claims, aud: 'https://attacker.test' });
  await expect(authorizePrivacyRequest(deps, 'assertion')).rejects.toMatchObject({ kind: 'forbidden' });
  expect(repository.consumeNonce).not.toHaveBeenCalled();
});
it('uses the stored registration and rejects replay before returning the request', async () => {
  const { deps, repository } = fixture();
  await expect(authorizePrivacyRequest(deps, 'assertion')).resolves.toEqual({ installation, request: { action: 'catalog' } });
  expect(deps.verify).toHaveBeenCalledWith('assertion', installation);
  expect(repository.consumeNonce).toHaveBeenCalledWith(installation, 'hash', 'catalog', new Date(160000));
  repository.consumeNonce.mockResolvedValue(false);
  await expect(authorizePrivacyRequest(deps, 'assertion')).rejects.toMatchObject({ kind: 'forbidden' });
});
