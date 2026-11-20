/** A consumed native-session marker outlives its session to prevent resurrection. */
export function nativeSessionMarkerExpiry(expiresAt: Date): Date {
  return new Date(expiresAt.getTime() + 120_000);
}
