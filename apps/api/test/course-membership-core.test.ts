import { expect, it, vi } from 'vitest';
import { acceptInvitation, declineInvitation, previewCourseInvitation, resendInvitation, inviteCourseMembers } from '../src/features/course-memberships/core';
import type { CourseMembershipDependencies } from '../src/features/course-memberships/ports';

function fixture() {
  return {
    now: () => new Date('2026-11-20T00:00:00Z'),
    createRepository: { create: vi.fn() },
    readRepository: { participants: vi.fn(), preview: vi.fn() },
    writeRepository: { decide: vi.fn(), control: vi.fn(), remove: vi.fn(), leave: vi.fn() },
    createToken: vi.fn().mockReturnValue('plain-token'),
    hashToken: vi.fn().mockResolvedValue('token-hash'),
    batchLimit: 2, emailDelivery: false, baseUrl: 'https://example.test',
  } satisfies CourseMembershipDependencies;
}

it('checks the normalized invitation batch before generating secrets or writing', async () => {
  const deps = fixture();
  await expect(inviteCourseMembers(deps, 1, 'owner', ['a@example.test', 'b@example.test', 'c@example.test'])).resolves.toEqual({ tooMany: true, limit: 2 });
  expect(deps.createToken).not.toHaveBeenCalled();
  expect(deps.createRepository.create).not.toHaveBeenCalled();
});

it('hashes decision tokens and leaves atomic permission checks to the write port', async () => {
  const deps = fixture();
  const now = new Date('2026-11-20T00:00:00Z');
  deps.writeRepository.decide.mockResolvedValue({ emailMismatch: true });
  await expect(acceptInvitation(deps, 'plain-token', 'user', now)).resolves.toEqual({ emailMismatch: true });
  expect(deps.writeRepository.decide).toHaveBeenLastCalledWith('accept', 'token-hash', 'user', now);
  await declineInvitation(deps, 'plain-token', 'user', now);
  expect(deps.writeRepository.decide).toHaveBeenLastCalledWith('decline', 'token-hash', 'user', now);
});

it('masks preview identity and computes expiration without mutating stored status', async () => {
  const deps = fixture();
  deps.readRepository.preview.mockResolvedValue({ course_id: 1, course_name: 'Course', inviter_name: 'Teacher', email: 'alice@example.test', status: 'pending', expires_at: '2026-11-20T00:00:00Z' });
  const result = await previewCourseInvitation(deps, 'plain-token');
  expect(result).toMatchObject({ status: 'expired', email_hint: 'a***e@example.test' });
  expect(result).not.toHaveProperty('email');
});

it('exposes a manual invitation URL only after successful token rotation', async () => {
  const deps = fixture();
  deps.writeRepository.control.mockResolvedValue({ invalidState: 'accepted' });
  await expect(resendInvitation(deps, 1, 2, 'owner')).resolves.toEqual({ invalidState: 'accepted' });
  deps.writeRepository.control.mockResolvedValue({ ok: true });
  await expect(resendInvitation(deps, 1, 2, 'owner')).resolves.toMatchObject({ invitation_url: 'https://example.test/course-invitations/plain-token' });
  deps.emailDelivery = true;
  expect(await resendInvitation(deps, 1, 2, 'owner')).not.toHaveProperty('invitation_url');
});

it('uses the injected operation clock at the invitation expiry boundary', async () => {
  const deps = fixture();
  const expires = '2026-11-20T00:00:00Z';
  deps.readRepository.preview.mockResolvedValue({ course_id: 1, course_name: 'Course', inviter_name: 'Teacher', email: 'alice@example.test', status: 'pending', expires_at: expires });
  expect(await previewCourseInvitation(deps, 'plain-token')).toMatchObject({ status: 'expired' });
  deps.now = () => new Date('2026-11-19T23:59:59.999Z');
  expect(await previewCourseInvitation(deps, 'plain-token')).toMatchObject({ status: 'pending' });
});
