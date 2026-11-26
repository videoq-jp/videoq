import { expect, it } from 'vitest';
import { courseOwnerPriority, courseAccessRole, courseArrayOrderPlanning, courseAuthenticatedRole, courseEditable, courseOrderAllowed, planSelectedCourseOrder, validCourseOrderInput } from '../src/domain/learning/course-management';
const logic = { and: (a: boolean, b: boolean) => a && b };
it('requires ownership and independent management for content mutations', () => {
  for (const owned of [false,true]) for (const native of [false,true]) expect(courseEditable(owned,native,logic)).toBe(owned&&native);
});
it('rejects empty, duplicate and foreign selection without requiring every course', () => {
  expect(validCourseOrderInput([])).toBe(false);
  expect(validCourseOrderInput([1,1])).toBe(false);
  expect(validCourseOrderInput([7,3])).toBe(true);
  expect(courseOrderAllowed({validInput:true,allSelectedOwned:false},logic)).toBe(false);
  expect(courseOrderAllowed({validInput:false,allSelectedOwned:true},logic)).toBe(false);
  expect(courseOrderAllowed({validInput:true,allSelectedOwned:true},logic)).toBe(true);
});
it('preserves sparse and repeated selected slots in requested order without mutating input', () => {
  const slots=[7,-2,7,100];
  expect(planSelectedCourseOrder([90,3,8,2],slots,courseArrayOrderPlanning)).toEqual([
    {id:90,slot:-2},{id:3,slot:7},{id:8,slot:7},{id:2,slot:100},
  ]);
  expect(slots).toEqual([7,-2,7,100]);
});
it('keeps public projection distinct from authenticated owner/member projection', () => {
  expect(courseAccessRole('public','owner')).toBe('public');
  expect(courseAccessRole({viewerUserId:'owner'},'owner')).toBe('owner');
  expect(courseAccessRole({viewerUserId:'reader'},'owner')).toBe('member');
  const choose=(owned:boolean,owner:'owner',member:'member')=>owned?owner:member;
  expect(courseAuthenticatedRole(true,{choose})).toBe('owner');
  expect(courseAuthenticatedRole(false,{choose})).toBe('member');
});

it('places owned courses before joined courses', () => {
  const choose=(owned:boolean,owner:0,member:1)=>owned?owner:member;
  expect(courseOwnerPriority(true,{choose})).toBe(0);
  expect(courseOwnerPriority(false,{choose})).toBe(1);
});
