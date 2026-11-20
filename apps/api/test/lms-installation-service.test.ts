import { expect, it, vi } from 'vitest';
import type { ProvisionInstallation } from '../src/application/lti-registration';
import type { LmsInstallationRepository } from '../src/persistence/contracts/lms-installation-repository';
import { createLmsInstallationService } from '../src/features/lms/installation-service';

const registration: ProvisionInstallation = {
  id: 'school', ownerUserId: 'owner', name: 'School', issuer: 'https://school.example',
  clientId: 'client', deploymentId: 'deployment', authorizationUrl: 'https://school.example/auth', jwksUrl: 'https://school.example/keys',
};
function fixture() {
  const repository = {
    insert: vi.fn<LmsInstallationRepository['insert']>().mockResolvedValue(),
    authenticate: vi.fn<LmsInstallationRepository['authenticate']>().mockResolvedValue(null),
    rotate: vi.fn<LmsInstallationRepository['rotate']>().mockResolvedValue('saved-school'),
  };
  const deps = {
    newToken: vi.fn(() => 'secret'), hash: vi.fn(async (_token: string): Promise<string | null> => 'digest'),
    repository: vi.fn(async () => repository),
  };
  return { repository, deps, service: createLmsInstallationService(deps) };
}

it('generates and hashes the token before opening persistence and returns it only after insertion', async () => {
  const { repository, deps, service } = fixture();
  deps.hash.mockImplementation(async token => {
    expect(token).toBe('secret'); expect(deps.repository).not.toHaveBeenCalled(); return 'digest';
  });
  repository.insert.mockImplementation(async value => {
    expect(value).toEqual({ ...registration, syncTokenHash: 'digest' });
    expect(deps.newToken).toHaveBeenCalledOnce(); expect(deps.hash).toHaveBeenCalledOnce();
  });
  expect(await service.provision(registration)).toEqual({ installationId: 'school', token: 'secret' });
  expect(repository.insert).toHaveBeenCalledOnce();
});

it('provisions service mode with no sync-token secret or hash', async () => {
  const { repository, deps, service } = fixture();
  const input = { ...registration, materialsService: { tokenEndpoint: 'https://school.example/token', endpoint: 'https://school.example/materials' } };
  expect(await service.provisionService(input)).toEqual({ installationId: 'school', mode: 'service' });
  expect(repository.insert).toHaveBeenCalledExactlyOnceWith({ ...input, syncTokenHash: null });
  expect(deps.newToken).not.toHaveBeenCalled(); expect(deps.hash).not.toHaveBeenCalled();
});

it('rejects an invalid token before opening persistence', async () => {
  const { deps, service } = fixture(); deps.hash.mockResolvedValue(null);
  expect(await service.authenticate('invalid')).toBeNull();
  expect(deps.repository).not.toHaveBeenCalled(); expect(deps.newToken).not.toHaveBeenCalled();
});

it('passes only the digest to authentication and retains the returned grant', async () => {
  const { repository, deps, service } = fixture();
  const grant = { id: 'school', issuer: registration.issuer, clientId: 'client', deploymentId: 'deployment' };
  repository.authenticate.mockResolvedValue(grant);
  expect(await service.authenticate('secret')).toBe(grant);
  expect(deps.hash).toHaveBeenCalledExactlyOnceWith('secret');
  expect(repository.authenticate).toHaveBeenCalledExactlyOnceWith('digest');
});

it('returns a rotated token only for the atomically updated installation identity', async () => {
  const { repository, service } = fixture();
  expect(await service.rotate('owner', 'requested-school')).toEqual({ installationId: 'saved-school', token: 'secret' });
  expect(repository.rotate).toHaveBeenCalledExactlyOnceWith('owner', 'requested-school', 'digest');
  repository.rotate.mockResolvedValue(null);
  expect(await service.rotate('other-owner', 'requested-school')).toBeNull();
});

it.each(['provision', 'rotate'] as const)('does not open persistence after a %s credential failure', async operation => {
  const { deps, service } = fixture(), error = new Error('hash failed');
  deps.hash.mockRejectedValue(error);
  await expect(operation === 'provision' ? service.provision(registration) : service.rotate('owner', 'school')).rejects.toBe(error);
  expect(deps.repository).not.toHaveBeenCalled();
});

it.each(['provision', 'provisionService', 'rotate'] as const)('propagates a failed %s commit without retrying or returning the credential', async operation => {
  const { repository, service } = fixture(), error = new Error('commit failed');
  repository.insert.mockRejectedValue(error); repository.rotate.mockRejectedValue(error);
  const promise = operation === 'provision' ? service.provision(registration)
    : operation === 'provisionService' ? service.provisionService({ ...registration, materialsService: { tokenEndpoint: 'https://school.example/token', endpoint: 'https://school.example/materials' } })
      : service.rotate('owner', 'school');
  await expect(promise).rejects.toBe(error);
  expect(repository.insert.mock.calls.length + repository.rotate.mock.calls.length).toBe(1);
});
