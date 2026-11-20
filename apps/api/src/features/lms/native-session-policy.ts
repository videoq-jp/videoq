import { nativeSessionMarkerExpiry } from '../../application/native-session-marker';
import { forbidden } from '../../application/errors';
import type { LearningGrant, NativeSessionInput } from '../../application/native-learning';

export interface NativeSessionPolicyDependencies {
  decode(value: unknown): LearningGrant | null;
  now(): number;
}
export const nativeSessionDenied = () => forbidden('The LMS learning session is unavailable.');
export function validateNativeSessionInput(input: NativeSessionInput, deps: NativeSessionPolicyDependencies): void {
  const grant = deps.decode(input.grant);
  if (!grant || grant.transport !== 'native' || !input.ownerUserId
    || new Set([input.sessionHash, input.markerHash, input.nonceHash]).size !== 3
    || [input.sessionHash, input.markerHash, input.nonceHash].some(id => !id)
    || !Number.isFinite(nativeSessionMarkerExpiry(input.expiresAt).getTime())
    || !Number.isFinite(input.nonceExpiresAt.getTime())) throw nativeSessionDenied();
}
export function matchesNativeSession(payload: unknown, expiresAt: Date, input: NativeSessionInput, deps: NativeSessionPolicyDependencies): boolean {
  const stored = deps.decode(payload);
  if (!stored || stored.transport !== 'native' || expiresAt.getTime() <= deps.now() || expiresAt.getTime() !== input.expiresAt.getTime()) return false;
  for (const field of ['registrationId', 'registrationHash', 'subjectHash', 'deploymentId', 'contextId', 'resourceLinkId', 'courseId', 'videoId', 'resourceGeneration', 'serviceSubject'] as const) {
    if (stored[field] !== input.grant[field]) return false;
  }
  return true;
}
