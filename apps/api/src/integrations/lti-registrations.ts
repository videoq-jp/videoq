import { mergeLtiRegistrations } from '../domain/lms/registration-policy';
import { createLtiRegistrationRepository } from '../persistence/factory';
import { ltiConfig } from '../features/lti/config';
import { features } from '../lib/deployment';
import type { Bindings } from '../types/bindings';

/** Load fresh bindings on every request so revocation remains immediate. */
export async function resolvedLtiConfig(env: Bindings, platform?: { issuer: string; clientId: string }) {
  const config = ltiConfig(env);
  if (!config?.databaseRegistrations) return config;
  const snapshot = await (await createLtiRegistrationRepository(env)).snapshot(platform);
  return { ...config, registrations: mergeLtiRegistrations(config.registrations, snapshot, {
    get youtube() { return features(env).youtube; }, origin: issuer => new URL(issuer).origin,
  }) };
}
