export interface MembershipLogic<T> {
  and(left: T, right: T): T;
  or(left: T, right: T): T;
}
const booleanLogic: MembershipLogic<boolean> = {
  and: (left, right) => left && right,
  or: (left, right) => left || right,
};

/** Keep first-occurrence order for append operations. */
export function uniqueMembershipIds(ids: readonly number[]): number[] {
  return [...new Set(ids)];
}

export function membershipCourseAllowed<T>(facts: { owned: T; native: T }, logic: MembershipLogic<T>): T {
  return logic.and(facts.owned, facts.native);
}

/** Native course management cannot add LMS media, but may clean up an owned legacy link. */
export function membershipVideoAllowed<T>(operation: 'add' | 'remove', facts: { owned: T; native: T }, logic: MembershipLogic<T>): T {
  return operation === 'remove' ? facts.owned : logic.and(facts.owned, facts.native);
}

/** Existing foreign tag links remain reusable; creating a new foreign link is forbidden. */
export function tagAttachmentAllowed<T>(facts: { owned: T; alreadyLinked: T }, logic: MembershipLogic<T>): T {
  return logic.or(facts.owned, facts.alreadyLinked);
}

export function planTagAttachment(requested: readonly number[], tags: readonly {
  id: number; ownerUserId: string; alreadyLinked: boolean;
}[], ownerUserId: string): { kind: 'missing' } | { kind: 'add'; ids: number[] } {
  if (tags.length !== uniqueMembershipIds(requested).length
    || tags.some(tag => !tagAttachmentAllowed({ owned: tag.ownerUserId === ownerUserId, alreadyLinked: tag.alreadyLinked }, booleanLogic))) {
    return { kind: 'missing' };
  }
  return { kind: 'add', ids: tags.filter(tag => !tag.alreadyLinked).map(tag => tag.id) };
}

export function membershipOrderAllowed<T>(facts: { sameSize: T; unique: T; allMembers: T }, logic: MembershipLogic<T>): T {
  return logic.and(logic.and(facts.sameSize, facts.unique), facts.allMembers);
}

/** PostgreSQL supplies locked membership rows; D1 compiles the same three facts. */
export function matchesMembershipOrder(requested: readonly number[], members: readonly number[]): boolean {
  const memberIds = new Set(members);
  return membershipOrderAllowed({ sameSize: requested.length === members.length,
    unique: new Set(requested).size === requested.length, allMembers: requested.every(id => memberIds.has(id)),
  }, booleanLogic);
}
