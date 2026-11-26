import { nativeCourseExternalAllowed, nativeCourseAccessAllowed } from '../learning/native-course-access';

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

/** Course access is checked separately. Anonymous readers never gain posting
 * rights; native moderation belongs to the independently authenticated owner. */
export function qaNativePermissions<T>(authenticated: T, owner: T): QaPermissions<T> {
  return { canPost: authenticated, canVote: authenticated, canDeleteOwn: authenticated, canModerate: owner };
}

/** Both the original source and currently attached video must remain visible.
 * Null bindings permit course-level posts, including an empty LMS video scope. */
export function qaQuestionScopeAllowed<T>(facts: {
  sourceUnbound: T; sourceGranted: T; videoUnbound: T; videoGranted: T;
}, logic: QaLogic<T>): T {
  return logic.and(logic.or(facts.sourceUnbound, facts.sourceGranted),
    logic.or(facts.videoUnbound, facts.videoGranted));
}
export type QaOperation =
  | "qa.ask" | "qa.reply" | "qa.vote" | "qa.feature"
  | "qa.updateQuestion" | "qa.deleteQuestion" | "qa.updateReply" | "qa.deleteReply";

/** Evaluate locked facts or atomic predicates without separating them from writes. */
export function qaMutationEffects<T>(operation: QaOperation, facts: {
  ownQuestion: T; ownReply: T; featureChanged: T; featured: boolean;
}, logic: QaLogic<T>): {
  touchQuestion: boolean;
  moderation: { action: 'delete_question' | 'delete_reply' | 'feature' | 'unfeature'; when: T } | null;
} {
  return {
    touchQuestion: operation === 'qa.reply' || operation === 'qa.updateReply' || operation === 'qa.deleteReply',
    moderation: operation === 'qa.deleteQuestion' ? { action: 'delete_question', when: logic.not(facts.ownQuestion) }
      : operation === 'qa.deleteReply' ? { action: 'delete_reply', when: logic.not(facts.ownReply) }
      : operation === 'qa.feature' ? { action: facts.featured ? 'feature' : 'unfeature', when: facts.featureChanged }
      : null,
  };
}

export function qaContentAbilities<T>(permissions: Pick<QaPermissions<T>, "canPost" | "canDeleteOwn" | "canModerate">, own: T, logic: QaLogic<T>) {
  return {
    canEdit: logic.and(own, permissions.canPost),
    canDelete: logic.or(logic.and(own, permissions.canDeleteOwn), permissions.canModerate),
  };
}

const qaOperationPermission = {
  'qa.ask': 'post', 'qa.reply': 'post', 'qa.vote': 'vote', 'qa.feature': 'moderate',
  'qa.updateQuestion': 'editQuestion', 'qa.deleteQuestion': 'deleteQuestion',
  'qa.updateReply': 'editReply', 'qa.deleteReply': 'deleteReply',
} as const satisfies Record<QaOperation, string>;

export function qaMutationAllowed<T>(operation: QaOperation, permissions: QaPermissions<T>,
  ownQuestion: T, ownReply: T, logic: QaLogic<T>): T {
  switch (qaOperationPermission[operation]) {
    case 'post': return permissions.canPost;
    case 'vote': return permissions.canVote;
    case 'moderate': return permissions.canModerate;
    case 'editQuestion': return qaContentAbilities(permissions, ownQuestion, logic).canEdit;
    case 'deleteQuestion': return qaContentAbilities(permissions, ownQuestion, logic).canDelete;
    case 'editReply': return qaContentAbilities(permissions, ownReply, logic).canEdit;
    case 'deleteReply': return qaContentAbilities(permissions, ownReply, logic).canDelete;
  }
}
/** A coarse request guard; the final write still checks ownership atomically.
 * Read operations have no mutation permission beyond view. */
export function qaOperationPrecheck(action: string, permissions: QaPermissions<boolean> & { view: boolean }): boolean {
  if (!permissions.view) return false;
  const operation = 'qa.' + action;
  if (!Object.hasOwn(qaOperationPermission, operation)) return true;
  return qaMutationAllowed(operation as QaOperation, permissions, true, true, qaBooleanLogic);
}

/** A share always uses native access rules, even for the authenticated owner. */
export function qaNativeAccessAllowed<T>(usingShare: boolean, facts: {
  owner: T; nativeEnabled: T; member: T; shareMatches: T;
}, logic: QaLogic<T>): T {
  return nativeCourseAccessAllowed(usingShare, { ...facts, participant: facts.member }, logic);
}

/** LMS authority survives detachment and also protects mixed native/LMS courses. */
export function qaNativeParticipationAllowed<T>(facts: {
  managedByLms: T; nativeAccessDisabled: T; hasLmsVideo: T;
}, logic: QaLogic<T>): T {
  return nativeCourseExternalAllowed({ independentlyManaged: logic.not(facts.managedByLms),
    nativeAccessEnabled: logic.not(facts.nativeAccessDisabled), noLmsVideo: logic.not(facts.hasLmsVideo) }, logic);
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
