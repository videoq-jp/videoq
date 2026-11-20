import { expect, it, vi } from 'vitest';
import { createCredentialService, type CredentialDependencies } from '../src/features/lti/credential-service';

function fixture() {
  const deps = {
    repository: { put: vi.fn(), read: vi.fn(), replacePayload: vi.fn(), recordScopeVideos: vi.fn(), consume: vi.fn(), prune: vi.fn(), putFeedback: vi.fn() },
    now: () => 1000,
    decodeSession: vi.fn<(payload: Record<string, unknown> | null) => { registrationId: string; subjectHash: string } | null>(),
  } satisfies CredentialDependencies;
  return { deps, service: createCredentialService(deps) };
}

it('derives retention from the injected clock and keeps one-use and replace operations atomic', async () => {
  const { deps, service } = fixture();
  await service.put('login', 'login', { nonce: 'n' }, 60);
  expect(deps.repository.put).toHaveBeenCalledWith('login', 'login', { nonce: 'n' }, 61000);
  deps.repository.consume.mockResolvedValue(false);
  await expect(service.consume('login', 'login')).resolves.toBe(false);
  expect(deps.repository.read).not.toHaveBeenCalled();
  deps.repository.replacePayload.mockResolvedValue(false);
  await expect(service.replacePayload('session', 'session', {})).resolves.toBe(false);
  expect(deps.repository.put).toHaveBeenCalledTimes(1);
});

it('rejects missing or invalid session proof before feedback persistence', async () => {
  const { deps, service } = fixture();
  deps.repository.read.mockResolvedValue(null);
  deps.decodeSession.mockReturnValue(null);
  await expect(service.putFeedback('feedback', 'a'.repeat(64), 1, 2)).rejects.toMatchObject({ kind: 'forbidden' });
  deps.decodeSession.mockReturnValue({ registrationId: 'reg', subjectHash: 'invalid' });
  await expect(service.putFeedback('feedback', 'a'.repeat(64), 1, 2)).rejects.toMatchObject({ kind: 'forbidden' });
  expect(deps.repository.putFeedback).not.toHaveBeenCalled();
});

it('passes the stored identity and bounded expiry to the atomic feedback capability', async () => {
  const { deps, service } = fixture();
  deps.decodeSession.mockReturnValue({ registrationId: 'reg', subjectHash: 'b'.repeat(64) });
  await service.putFeedback('feedback', 'a'.repeat(64), 1, 2);
  expect(deps.repository.read).toHaveBeenCalledWith('a'.repeat(64), 'session');
  expect(deps.repository.putFeedback).toHaveBeenCalledWith('feedback', { sessionHash: 'a'.repeat(64), registrationId: 'reg', subjectHash: 'b'.repeat(64) }, 1, 2, 3601000);
});
