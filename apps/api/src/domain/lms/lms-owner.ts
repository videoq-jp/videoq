/** Database adapters may compile this policy directly into guarded reads/writes. */
export interface LmsOwnerLogic<Time, Predicate> {
  and(left: Predicate, right: Predicate): Predicate;
  or(left: Predicate, right: Predicate): Predicate;
  atOrBefore(expires: Time, now: Time): Predicate;
}

/** LMS bans expire inclusively; an active, non-deactivated owner is also required. */
export function lmsOwnerAvailable<Time, Predicate>(facts: {
  active: Predicate; notDeactivated: Predicate; notBanned: Predicate; banExpires: Time; now: Time;
}, logic: LmsOwnerLogic<Time, Predicate>): Predicate {
  return logic.and(logic.and(facts.active, facts.notDeactivated),
    logic.or(facts.notBanned, logic.atOrBefore(facts.banExpires, facts.now)));
}

export type MaterialTeacherConnection = { ownerUserId: string; courseId: number; resourceLinkId: string | null };

/** A native-linked entry is not a material-push connection. Check that before
 * comparing an optional caller-supplied owner with the independently linked teacher. */
export function materialTeacherConnectionAccess<Connection extends MaterialTeacherConnection>(connection: Connection | null | undefined, grantOwnerUserId?: string) {
  if (!connection || connection.resourceLinkId) return { kind: 'denied', code: 'TEACHER_CONNECTION_REQUIRED' } as const;
  if (grantOwnerUserId && grantOwnerUserId !== connection.ownerUserId) return { kind: 'denied', code: 'INSTALLATION_UNAVAILABLE' } as const;
  return { kind: 'ready', connection } as const;
}

/** PostgreSQL rechecks this connection after taking the owner/installation locks. */
export function materialTeacherConnectionStable(connection: MaterialTeacherConnection | null | undefined,
  expected: { ownerUserId: string; courseId: number }): boolean {
  return Boolean(connection && !connection.resourceLinkId
    && connection.ownerUserId === expected.ownerUserId && connection.courseId === expected.courseId);
}

/** D1 fences this mapping and the connection snapshot in its atomic mutation batch. */
export function materialTeacherCourseMatches(mapping: { courseId: number } | null | undefined, courseId: number): boolean {
  return Boolean(mapping && mapping.courseId === courseId);
}
