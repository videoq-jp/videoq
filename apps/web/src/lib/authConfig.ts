import { isOnprem } from "./deployment";
/**
 * Must stay in sync with the backend rule
 * (`emailAndPassword.minPasswordLength` in apps/api/src/lib/auth.ts).
 * A lower value here only produces a server-side rejection after submit.
 */
export const PASSWORD_MIN_LENGTH = 12;

const PUBLIC_AUTH_PATHS = [
  '/login',
  '/signup',
  '/signup/check-email',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/change-email',
  '/consent',
  '/share',
  '/course-invitations',
  '/try',
  '/pricing',
  '/terms',
  '/privacy',
  '/refund',
  '/legal',
  '/guides',
] as const;

export function isPublicAuthPath(pathname: string): boolean {
  if (isOnprem) return ['/login', '/reset-password', '/consent', '/share', '/course-invitations'].some(path => pathname === path || pathname.startsWith(`${path}/`));
  if (pathname === '/') return true;
  return PUBLIC_AUTH_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}
