import type { NativeSessionInput } from '../../application/native-learning';
export type { NativeSessionInput } from '../../application/native-learning';
/** Consume one signed request without replacing an existing session or its scope union. */
export interface NativeSessionRepository { ensure(input: NativeSessionInput): Promise<void>; }
