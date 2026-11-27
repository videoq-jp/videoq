import { describe, expect, it, vi } from 'vitest';
import { createMoodlePairingService, type MoodlePairingDependencies } from '../src/features/lms/pairing-service';
import type { PairingExchangeInput } from '../src/domain/lms/moodle-pairing';

function setup(mode: 'legacy' | 'materials' = 'materials') {
  const deps = {
    mode, now: () => 1000, randomSecret: vi.fn(() => 'secret'),
    digest: vi.fn(async (value: string) => 'hash:' + value),
    encodeCode: vi.fn(() => 'encoded'),
    repository: { issue: vi.fn(async () => {}), exchange: vi.fn(async () => ({ installationId: 'installation', ownerUserId: 'owner' })) },
    scheduleMaintenance: vi.fn(async () => {}),
    settings: vi.fn(async (installationId: string) => ({ installationId, toolOrigin: 'https://tool.test', uploadTargets: [] })),
  } satisfies MoodlePairingDependencies;
  return { deps, service: createMoodlePairingService(deps) };
}
const input: PairingExchangeInput = { secret: 'secret', issuer: 'https://moodle.test', clientId: 'client', deploymentId: '1', mode: 'materials' };

describe('Moodle pairing application workflow', () => {
  it.each(['legacy', 'materials'] as const)('issues %s codes with bound identity and expiry', async mode => {
    const { deps, service } = setup(mode);
    const challenge = mode === 'materials' ? 'a'.repeat(43) : undefined;
    const result = await service.issue('owner', 'https://moodle.test', 'https://tool.test', challenge);
    expect(deps.repository.issue).toHaveBeenCalledWith({ ownerUserId: 'owner', ownerKey: 'hash:moodle-pairing-owner:owner', codeHash: 'hash:moodle-pairing:secret',
      payload: { ownerUserId: 'owner', moodleUrl: 'https://moodle.test', mode, ...(challenge ? { codeChallenge: challenge } : {}) }, expiresAt: 601000 });
    expect(result).toEqual({ code: (mode === 'materials' ? 'VIDEOQ2.' : 'VIDEOQ1.') + 'encoded', moodleUrl: 'https://moodle.test', expiresAt: new Date(601000).toISOString() });
    expect(deps.encodeCode).toHaveBeenCalledWith('https://tool.test', 'secret');
  });
  it.each([['legacy', 'a'.repeat(43)], ['materials', 'invalid']] as const)('rejects unsupported proof before side effects', async (mode, challenge) => {
    const { deps, service } = setup(mode);
    await expect(service.issue('owner', 'url', 'origin', challenge)).rejects.toMatchObject({ kind: 'forbidden', code: 'LTI_MATERIALS_DISABLED' });
    expect(deps.randomSecret).not.toHaveBeenCalled();
    expect(deps.repository.issue).not.toHaveBeenCalled();
  });
  it('does not expose a code when persistence fails', async () => {
    const { deps, service } = setup();
    deps.repository.issue.mockRejectedValueOnce(new Error('save'));
    await expect(service.issue('owner', 'url', 'origin')).rejects.toThrow('save');
    expect(deps.encodeCode).not.toHaveBeenCalled();
  });
  it('commits exchange before scheduling and settings', async () => {
    const { deps, service } = setup();
    await expect(service.exchange(input)).resolves.toMatchObject({ installationId: 'installation', uploadTargets: [] });
    expect(deps.repository.exchange).toHaveBeenCalledWith(input, 'hash:moodle-pairing:secret', 'hash:lti-materials-pairing:secret');
    expect(deps.repository.exchange.mock.invocationCallOrder[0]).toBeLessThan(deps.scheduleMaintenance.mock.invocationCallOrder[0]);
    expect(deps.scheduleMaintenance.mock.invocationCallOrder[0]).toBeLessThan(deps.settings.mock.invocationCallOrder[0]);
  });
  it('returns legacy exchange without materials side effects', async () => {
    const { deps, service } = setup('legacy');
    await expect(service.exchange({ ...input, mode: 'legacy' })).resolves.toEqual({ installationId: 'installation' });
    expect(deps.scheduleMaintenance).not.toHaveBeenCalled();
    expect(deps.settings).not.toHaveBeenCalled();
  });
  it('does not run post-commit effects on rejected exchange', async () => {
    const { deps, service } = setup();
    deps.repository.exchange.mockRejectedValueOnce(new Error('rejected'));
    await expect(service.exchange(input)).rejects.toThrow('rejected');
    expect(deps.scheduleMaintenance).not.toHaveBeenCalled();
    expect(deps.settings).not.toHaveBeenCalled();
  });
  it('propagates maintenance failure without returning settings', async () => {
    const { deps, service } = setup();
    deps.scheduleMaintenance.mockRejectedValueOnce(new Error('schedule'));
    await expect(service.exchange(input)).rejects.toThrow('schedule');
    expect(deps.settings).not.toHaveBeenCalled();
  });
  it('propagates settings failure after successful commit', async () => {
    const { deps, service } = setup();
    deps.settings.mockRejectedValueOnce(new Error('settings'));
    await expect(service.exchange(input)).rejects.toThrow('settings');
    expect(deps.repository.exchange).toHaveBeenCalledTimes(1);
  });
});
