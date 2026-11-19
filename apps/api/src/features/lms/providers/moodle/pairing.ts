import { moodlePairingService } from '../../../../integrations/moodle-pairing';
import { ApplicationError } from '../../../../application/errors';
import { LmsSyncError } from '../../resource';
import { pairingExchangeSchema } from '../../../../shared/moodle-pairing-policy';
import type { Bindings } from '../../../../types/bindings';
import type { z } from 'zod';
export { moodleUrlSchema, pairingRequestSchema, pairingExchangeSchema, pairingCodeChallenge, PAIRING_SECONDS } from '../../../../shared/moodle-pairing-policy';

export async function issueMoodlePairing(env: Bindings, ownerUserId: string, moodleUrl: string, toolOrigin: string, codeChallenge?: string) {
  try {
    return await moodlePairingService(env).issue(ownerUserId, moodleUrl, toolOrigin, codeChallenge);
  } catch (error) {
    if (error instanceof ApplicationError && error.kind === 'forbidden' && error.code === 'LTI_MATERIALS_DISABLED') {
      throw new LmsSyncError(403, error.code);
    }
    throw error;
  }
}

export async function exchangeMoodlePairing(env: Bindings, rawInput: z.input<typeof pairingExchangeSchema>) {
  const input = pairingExchangeSchema.parse(rawInput);
  return moodlePairingService(env).exchange(input);
}
