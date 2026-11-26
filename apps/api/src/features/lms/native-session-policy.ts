import { nativeSessionInputAllowed, nativeSessionMatches } from '../../domain/lms/native-session-policy';
import { forbidden } from '../../application/errors';
import type { LearningGrant, NativeSessionInput } from '../../domain/lms/native-learning';

export interface NativeSessionPolicyDependencies {
  decode(value: unknown): LearningGrant | null;
  now(): number;
}
export const nativeSessionDenied = () => forbidden('The LMS learning session is unavailable.');
export function validateNativeSessionInput(input: NativeSessionInput, deps: NativeSessionPolicyDependencies): void {
  if (!nativeSessionInputAllowed(input, deps.decode(input.grant))) throw nativeSessionDenied();
}
export function matchesNativeSession(payload: unknown, expiresAt: Date, input: NativeSessionInput, deps: NativeSessionPolicyDependencies): boolean {
  return nativeSessionMatches(deps.decode(payload), expiresAt, input, deps.now());
}
