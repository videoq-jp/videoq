import { nativeSessionMarkerExpiry } from './native-session-marker';
import type { LearningGrant, NativeSessionInput } from './native-learning';
export function nativeSessionInputAllowed(input: NativeSessionInput, grant: LearningGrant | null): boolean {
  return !!grant && grant.transport === 'native' && !!input.ownerUserId
    && new Set([input.sessionHash, input.markerHash, input.nonceHash]).size === 3
    && [input.sessionHash, input.markerHash, input.nonceHash].every(id => !!id)
    && Number.isFinite(nativeSessionMarkerExpiry(input.expiresAt).getTime()) && Number.isFinite(input.nonceExpiresAt.getTime());
}
export function nativeSessionMatches(stored: LearningGrant | null, expiresAt: Date, input: NativeSessionInput, now: number): boolean {
  if (!stored || stored.transport !== 'native' || expiresAt.getTime() <= now || expiresAt.getTime() !== input.expiresAt.getTime()) return false;
  return (['registrationId', 'registrationHash', 'subjectHash', 'deploymentId', 'contextId', 'resourceLinkId', 'courseId', 'videoId', 'resourceGeneration', 'serviceSubject'] as const)
    .every(field => stored[field] === input.grant[field]);
}
