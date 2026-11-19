import { describe, expect, it, vi } from 'vitest';
import { createTeachingService, type TeachingDependencies } from '../src/features/teaching/core';
import type { TeachingTicket } from '../src/application/teaching';

const input: TeachingTicket = { provider: 'moodle', installationId: 'school', contextId: 'class', teacherSubject: 'teacher', teacherName: 'Teacher', title: 'Course', returnUrl: 'https://school.example' };
function fixture() {
  const deps: TeachingDependencies = {
    randomTicket: () => 'ticket', digest: async value => `hash:${value}`,
    validateTicket: value => { if (value !== input) throw new Error('invalid'); return input; },
    saveTicket: vi.fn(async () => {}), loadTicket: vi.fn(async () => input),
    connectionUrl: ticket => `https://videoq.example/teaching/connect?ticket=${ticket}`,
    verifyAuthority: vi.fn(async () => {}),
    connect: vi.fn(async () => ({ returnUrl: input.returnUrl, courseId: 42 })),
  };
  return { deps, service: createTeachingService(deps) };
}
describe('teaching connection workflow', () => {
  it('stores only the digested ticket with a bounded lifetime', async () => {
    const { deps, service } = fixture();
    expect(await service.issueTeachingTicket(input)).toEqual({ url: 'https://videoq.example/teaching/connect?ticket=ticket' });
    expect(deps.saveTicket).toHaveBeenCalledWith('hash:ticket', input, 600);
  });
  it('rechecks authority before passing the ticket and selected course to the atomic commit', async () => {
    const { deps, service } = fixture();
    const order: string[] = [];
    vi.mocked(deps.verifyAuthority).mockImplementation(async () => { order.push('verify'); });
    vi.mocked(deps.connect).mockImplementation(async () => { order.push('commit'); return { returnUrl: input.returnUrl, courseId: 42 }; });
    await expect(service.connectTeachingCourse('ticket', 'owner', 42)).resolves.toEqual({ returnUrl: input.returnUrl, courseId: 42 });
    expect(order).toEqual(['verify', 'commit']);
    expect(deps.connect).toHaveBeenCalledWith('hash:ticket', 'owner', input, 42);
  });
  it('does not consume the ticket when external authority is denied', async () => {
    const { deps, service } = fixture();
    vi.mocked(deps.verifyAuthority).mockRejectedValue(new Error('denied'));
    await expect(service.connectTeachingCourse('ticket', 'owner')).rejects.toThrow('denied');
    expect(deps.connect).not.toHaveBeenCalled();
  });
  it('does not contact the provider or commit an invalid or expired ticket', async () => {
    const { deps, service } = fixture();
    vi.mocked(deps.loadTicket).mockResolvedValue(null);
    await expect(service.connectTeachingCourse('ticket', 'owner')).rejects.toThrow('invalid');
    expect(deps.verifyAuthority).not.toHaveBeenCalled();
    expect(deps.connect).not.toHaveBeenCalled();
  });
});
