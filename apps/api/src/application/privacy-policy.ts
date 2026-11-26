import { ApplicationError, forbidden } from './errors';

/** Recovery authority intentionally does not depend on active enrolment/quota. */
export function assertPrivacyRecovery(allowed: boolean, upgraded = true): void {
  if (!allowed) throw forbidden('Privacy request is unavailable.');
  if (!upgraded) throw new ApplicationError('unavailable', 'PRIVACY_UPGRADE_PENDING',
    'Drain older API writers and expire legacy recent-history caches before enabling privacy requests.');
}
