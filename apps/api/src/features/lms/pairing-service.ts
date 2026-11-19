import { ApplicationError } from '../../application/errors';
import { PAIRING_SECONDS, type PairingMode, type PairingExchangeInput, type PairingSettings } from '../../application/moodle-pairing';
import type { MoodlePairingRepository } from '../../persistence/contracts/moodle-pairing-repository';

export interface MoodlePairingDependencies {
  repository: MoodlePairingRepository;
  mode: PairingMode;
  now(): number;
  randomSecret(): string;
  digest(value: string): Promise<string>;
  encodeCode(origin: string, secret: string): string;
  scheduleMaintenance(now: number): Promise<void>;
  settings(installationId: string): Promise<PairingSettings>;
}

export function createMoodlePairingService(deps: MoodlePairingDependencies) {
  return {
    async issue(ownerUserId: string, moodleUrl: string, toolOrigin: string, codeChallenge?: string) {
      const mode = deps.mode;
      if (codeChallenge !== undefined && (mode !== 'materials' || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge))) {
        throw new ApplicationError('forbidden', 'LTI_MATERIALS_DISABLED', 'LTI_MATERIALS_DISABLED');
      }
      const secret = deps.randomSecret();
      const expiresAt = new Date(deps.now() + PAIRING_SECONDS * 1000);
      await deps.repository.issue({
        ownerUserId, ownerKey: await deps.digest('moodle-pairing-owner:' + ownerUserId),
        codeHash: await deps.digest('moodle-pairing:' + secret),
        payload: { ownerUserId, moodleUrl, mode, ...(codeChallenge ? { codeChallenge } : {}) },
        expiresAt: expiresAt.getTime(),
      });
      const code = (mode === 'materials' ? 'VIDEOQ2.' : 'VIDEOQ1.') + deps.encodeCode(toolOrigin, secret);
      return { code, moodleUrl, expiresAt: expiresAt.toISOString() };
    },
    async exchange(input: PairingExchangeInput) {
      const codeHash = await deps.digest('moodle-pairing:' + input.secret);
      const receiptId = await deps.digest('lti-materials-pairing:' + input.secret);
      // Code consumption and provisioning stay in one atomic repository operation.
      const result = await deps.repository.exchange(input, codeHash, receiptId);
      if (input.mode === 'materials') {
        await deps.scheduleMaintenance(deps.now());
        return deps.settings(result.installationId);
      }
      return { installationId: result.installationId };
    },
  };
}
