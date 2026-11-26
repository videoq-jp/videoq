import { asApiError } from './errors';
import { sessionRecord } from '../features/lti/protocol';
import * as policy from '../features/lms/native-session-policy';
import type { NativeSessionInput } from '../domain/lms/native-learning';
const dependencies: policy.NativeSessionPolicyDependencies = {
  decode: value => { const result = sessionRecord.safeParse(value); return result.success ? result.data : null; },
  now: () => Date.now(),
};
export const nativeSessionDenied = () => asApiError(policy.nativeSessionDenied())!;
export function validateNativeSessionInput(input: NativeSessionInput): void {
  try { policy.validateNativeSessionInput(input, dependencies); }
  catch (error) { throw asApiError(error) ?? error; }
}
export function matchesNativeSession(payload: unknown, expiresAt: Date, input: NativeSessionInput): boolean {
  return policy.matchesNativeSession(payload, expiresAt, input, dependencies);
}
