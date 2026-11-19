import { createMoodlePairingService } from '../features/lms/pairing-service';
import { ltiConfig, ltiMaterialsEnabled } from '../features/lti/config';
import { digest, randomSecret } from '../features/lti/store';
import { createMoodlePairingRepository } from '../persistence/factory';
import { armMaintenance } from '../lib/task-scheduler';
import { presignR2Put } from './media';
import type { Bindings } from '../types/bindings';

export function moodlePairingService(env: Bindings) {
  // Keep repository creation lazy: rejected commands must not touch persistence.
  return createMoodlePairingService({
    repository: {
      issue: async input => (await createMoodlePairingRepository(env)).issue(input),
      exchange: async (input, hash, receipt) => (await createMoodlePairingRepository(env)).exchange(input, hash, receipt),
    },
    get mode() { return ltiMaterialsEnabled(env) ? 'materials' : 'legacy'; },
    now: Date.now, randomSecret, digest,
    encodeCode: (origin, secret) => btoa(JSON.stringify({ origin, secret })),
    scheduleMaintenance: now => armMaintenance(env, now),
    settings: async installationId => {
      const url = new URL(await presignR2Put(env, 'videos/policy', 'video/mp4', 1));
      return { installationId, toolOrigin: ltiConfig(env)!.toolOrigin,
        uploadTargets: [{ origin: url.origin, prefix: url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) }] };
    },
  });
}
