/** Boolean facts or atomic predicates supplied by outer adapters. */
export interface NativeCourseLogic<T> {
  and(left: T, right: T): T;
  or(left: T, right: T): T;
}

/** Native links and invitations must never bypass LMS authority, including
 * historical native courses containing an LMS-controlled video. */
export function nativeCourseExternalAllowed<T>(facts: {
  independentlyManaged: T; nativeAccessEnabled: T; noLmsVideo: T;
}, logic: NativeCourseLogic<T>): T {
  return logic.and(logic.and(facts.independentlyManaged, facts.nativeAccessEnabled), facts.noLmsVideo);
}

/** A share always requires native eligibility, even for an authenticated owner.
 * Independent owner access survives LMS takeover. Participants must still have
 * the operation's own membership/author authority, supplied as a separate fact. */
export function nativeCourseAccessAllowed<T>(usingShare: boolean, facts: {
  owner: T; nativeEnabled: T; participant: T; shareMatches: T;
}, logic: NativeCourseLogic<T>): T {
  return usingShare ? logic.and(facts.nativeEnabled, facts.shareMatches)
    : logic.or(facts.owner, logic.and(facts.nativeEnabled, facts.participant));
}
