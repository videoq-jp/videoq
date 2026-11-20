/** Database adapters can evaluate the same rules within atomic predicates. */
export interface CourseManagementLogic<T> {
  and(left: T, right: T): T;
}

export function courseEditable<T>(owned: T, independentlyManaged: T, logic: CourseManagementLogic<T>): T {
  return logic.and(owned, independentlyManaged);
}

export function validCourseOrderInput(ids: readonly number[]): boolean {
  return ids.length > 0 && new Set(ids).size === ids.length;
}

/** Reordering a selected subset is allowed, including owner-managed LMS slots.
 * The selection must contain every requested ID, all belonging to the actor. */
export function courseOrderAllowed<T>(facts: { validInput: T; allSelectedOwned: T }, logic: CourseManagementLogic<T>): T {
  return logic.and(facts.validInput, facts.allSelectedOwned);
}

export interface CourseOrderPlanning<Request, Slots, Assignment> {
  sortAscending(slots: Slots): Slots;
  assignInRequestOrder(requested: Request, sortedSlots: Slots): Assignment;
}

/** Preserve the selected slot multiset, including duplicate and sparse values;
 * assign its ascending values to the requested course order. */
export function planSelectedCourseOrder<Request, Slots, Assignment>(requested: Request, slots: Slots,
  logic: CourseOrderPlanning<Request, Slots, Assignment>): Assignment {
  return logic.assignInRequestOrder(requested, logic.sortAscending(slots));
}

export const courseArrayOrderPlanning: CourseOrderPlanning<readonly number[], readonly number[], { id: number; slot: number }[]> = {
  sortAscending: slots => [...slots].sort((a, b) => a - b),
  assignInRequestOrder: (requested, slots) => requested.map((id, index) => ({ id, slot: slots[index] })),
};

export function courseAccessRole(viewer: 'public' | { viewerUserId: string }, ownerUserId: string): 'public' | 'owner' | 'member' {
  return viewer === 'public' ? 'public' : viewer.viewerUserId === ownerUserId ? 'owner' : 'member';
}

export interface CourseRoleChoice<Predicate, Value> {
  choose(owned: Predicate, owner: 'owner', member: 'member'): Value;
}
export function courseAuthenticatedRole<Predicate, Value>(owned: Predicate, logic: CourseRoleChoice<Predicate, Value>): Value {
  return logic.choose(owned, 'owner', 'member');
}

export interface CoursePriorityChoice<Predicate, Value> {
  choose(owned: Predicate, owner: 0, member: 1): Value;
}
/** Owned courses precede joined courses, before display/date/ID tie breakers. */
export function courseOwnerPriority<Predicate, Value>(owned: Predicate, logic: CoursePriorityChoice<Predicate, Value>): Value {
  return logic.choose(owned, 0, 1);
}
