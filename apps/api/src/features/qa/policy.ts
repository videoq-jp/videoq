/** Q&A policy is independent of transport, persistence and runtime configuration.
 * Adapters supply boolean facts or atomic SQL predicates through this algebra.
 * SQL predicates must be composed from adapter-owned expressions/bound parameters.
 */
export interface QaLogic<T> {
  and(left: T, right: T): T;
  or(left: T, right: T): T;
  not(value: T): T;
}
export const qaBooleanLogic: QaLogic<boolean> = {
  and: (left, right) => left && right,
  or: (left, right) => left || right,
  not: value => !value,
};
export interface QaPermissions<T> {
  canPost: T;
  canVote: T;
  canDeleteOwn: T;
  canModerate: T;
}
export type QaOperation =
  | "qa.ask" | "qa.reply" | "qa.vote" | "qa.feature"
  | "qa.updateQuestion" | "qa.deleteQuestion" | "qa.updateReply" | "qa.deleteReply";

export function qaContentAbilities<T>(permissions: Pick<QaPermissions<T>, "canPost" | "canDeleteOwn" | "canModerate">, own: T, logic: QaLogic<T>) {
  return {
    canEdit: logic.and(own, permissions.canPost),
    canDelete: logic.or(logic.and(own, permissions.canDeleteOwn), permissions.canModerate),
  };
}

export function qaMutationAllowed<T>(operation: QaOperation, permissions: QaPermissions<T>,
  ownQuestion: T, ownReply: T, logic: QaLogic<T>): T {
  switch (operation) {
    case "qa.ask": case "qa.reply": return permissions.canPost;
    case "qa.vote": return permissions.canVote;
    case "qa.feature": return permissions.canModerate;
    case "qa.updateQuestion": return qaContentAbilities(permissions, ownQuestion, logic).canEdit;
    case "qa.deleteQuestion": return qaContentAbilities(permissions, ownQuestion, logic).canDelete;
    case "qa.updateReply": return qaContentAbilities(permissions, ownReply, logic).canEdit;
    case "qa.deleteReply": return qaContentAbilities(permissions, ownReply, logic).canDelete;
  }
}

/** A share always uses native access rules, even for the authenticated owner. */
export function qaNativeAccessAllowed<T>(usingShare: boolean, facts: {
  owner: T; nativeEnabled: T; member: T; shareMatches: T;
}, logic: QaLogic<T>): T {
  return usingShare
    ? logic.and(facts.nativeEnabled, facts.shareMatches)
    : logic.or(facts.owner, logic.and(facts.nativeEnabled, facts.member));
}

/** LMS authority survives detachment and also protects mixed native/LMS courses. */
export function qaNativeParticipationAllowed<T>(facts: {
  managedByLms: T; nativeAccessDisabled: T; hasLmsVideo: T;
}, logic: QaLogic<T>): T {
  return logic.not(logic.or(logic.or(facts.managedByLms, facts.nativeAccessDisabled), facts.hasLmsVideo));
}

/** Empty LMS scopes permit course-level posts, but never another owner's course. */
export function qaLtiAccessAllowed<T>(facts: {
  validScope: T; ownerMatches: T; emptyScope: T; hasVisibleMember: T;
}, logic: QaLogic<T>): T {
  return logic.and(logic.and(facts.validScope, facts.ownerMatches),
    logic.or(facts.emptyScope, facts.hasVisibleMember));
}

/** Database ownership, session validity and current video visibility are checked
 * separately by the adapter, in the same transaction/batch as the operation. */
export function validLtiQaScope(principal: {
  kind: string; courseId: number; authorId: string; videoIds: readonly number[];
  permissions: { view: boolean };
}, access: { courseId: number; shareSlug?: string }): boolean {
  return principal.kind === "lti" && principal.courseId === access.courseId
    && principal.permissions.view && access.shareSlug === undefined
    && /^[a-f0-9]{64}$/.test(principal.authorId) && principal.videoIds.length <= 1000;
}
