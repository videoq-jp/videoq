import { isSafeMediaPath } from './media-path';

export type MediaAccessMode = { kind: 'shared'; shareSlug: string; safePath: boolean }
  | { kind: 'user'; userId: string } | { kind: 'denied' };

/** A supplied share (even empty) takes precedence over independent user access.
 * Resolve its existence even for unsafe paths to preserve invalid-share results. */
export function mediaAccessMode(path: string, options: { userId?: string | null; shareSlug?: string | null }): MediaAccessMode {
  const safePath = isSafeMediaPath(path);
  if (options.shareSlug != null) return { kind: 'shared', shareSlug: options.shareSlug, safePath };
  if (!safePath || options.userId == null) return { kind: 'denied' };
  return { kind: 'user', userId: options.userId };
}

export function mediaSharedPermission<Predicate>(safePath: Predicate, linkedToCourse: Predicate,
  logic: { and(left: Predicate, right: Predicate): Predicate }): Predicate {
  return logic.and(safePath, linkedToCourse);
}

/** Eligible membership already includes native course authority. Owners may
 * read unfinished files; completed-video eligibility must not be added here. */
export function mediaAuthenticatedPermission<Predicate>(owned: Predicate, eligibleMembership: Predicate,
  logic: { or(left: Predicate, right: Predicate): Predicate }): Predicate {
  return logic.or(owned, eligibleMembership);
}

/** Invalid paths still require share identity resolution, but must not be sent
 * to a storage comparison (some drivers reject NUL before evaluating false). */
export function mediaSharedPathValue<Value>(safePath: boolean, membership: () => Value, denied: Value): Value {
  return safePath ? membership() : denied;
}
