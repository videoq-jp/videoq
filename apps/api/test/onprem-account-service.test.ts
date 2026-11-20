import { describe, expect, it, vi } from 'vitest';
import { createOnpremAccountService, type OnpremAccountDependencies, type OnpremAccountSession } from '../src/application/onprem-accounts';

function fixture(enabled = true) {
  const events: string[] = [];
  const accounts: OnpremAccountSession = {
    create: vi.fn(async () => { events.push('create'); return { id: 'new-user', email: 'canonical@example.test' }; }),
    findEmail: vi.fn(async () => 'stored@example.test'),
    requestActivation: vi.fn(async () => { events.push('activation'); return 'https://app.test/reset-password?token=opaque'; }),
  };
  const deps: OnpremAccountDependencies = {
    enabled,
    async transaction(work) {
      events.push('begin');
      try {
        const value = await work(accounts);
        events.push('commit');
        return value;
      } catch (error) { events.push('rollback'); throw error; }
    },
    session: work => work(accounts),
  };
  const transaction = vi.spyOn(deps, 'transaction');
  const session = vi.spyOn(deps, 'session');
  return { service: createOnpremAccountService(deps), accounts, events, transaction, session };
}

describe('on-premises account lifecycle use cases', () => {
  it('rejects unavailable operations before opening a connection', async () => {
    const f = fixture(false);
    await expect(f.service.provision({ email: 'a@test', username: 'a' })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(f.service.resetAccess('id')).rejects.toMatchObject({ kind: 'not_found' });
    expect(f.transaction).not.toHaveBeenCalled();
    expect(f.session).not.toHaveBeenCalled();
  });

  it.each([false, true])('normalizes identities and issues activation inside creation transaction (admin=%s)', async admin => {
    const f = fixture();
    const result = await f.service.provision({ email: ' User@Example.test ', username: ' User_Name ', admin });
    expect(f.accounts.create).toHaveBeenCalledWith({ email: 'user@example.test', username: 'user_name', role: admin ? 'admin' : 'user' });
    expect(f.accounts.requestActivation).toHaveBeenCalledWith('user@example.test');
    expect(f.events).toEqual(['begin', 'create', 'activation', 'commit']);
    expect(result).toEqual({ id: 'new-user', username: 'user_name', email: 'canonical@example.test', activation_url: 'https://app.test/reset-password?token=opaque' });
  });

  it('lets activation failure abort the creation transaction', async () => {
    const f = fixture();
    vi.mocked(f.accounts.requestActivation).mockResolvedValue(undefined);
    await expect(f.service.provision({ email: 'a@test', username: 'a' })).rejects.toThrow('Could not create an account activation link');
    expect(f.events).toEqual(['begin', 'create', 'rollback']);
  });

  it('propagates provider creation errors without issuing an activation link', async () => {
    const f = fixture();
    const failure = new Error('provider unavailable');
    vi.mocked(f.accounts.create).mockRejectedValue(failure);
    await expect(f.service.provision({ email: 'a@test', username: 'a' })).rejects.toBe(failure);
    expect(f.accounts.requestActivation).not.toHaveBeenCalled();
    expect(f.events).toEqual(['begin', 'rollback']);
  });

  it('does not issue a reset token for an unknown user', async () => {
    const f = fixture();
    vi.mocked(f.accounts.findEmail).mockResolvedValue(null);
    await expect(f.service.resetAccess('missing')).rejects.toMatchObject({ kind: 'not_found', message: 'User not found' });
    expect(f.accounts.requestActivation).not.toHaveBeenCalled();
  });

  it('resets the current stored email without creating another user', async () => {
    const f = fixture();
    expect(await f.service.resetAccess('existing')).toEqual({ activation_url: 'https://app.test/reset-password?token=opaque' });
    expect(f.accounts.findEmail).toHaveBeenCalledWith('existing');
    expect(f.accounts.requestActivation).toHaveBeenCalledWith('stored@example.test');
    expect(f.accounts.create).not.toHaveBeenCalled();
    expect(f.transaction).not.toHaveBeenCalled();
  });
});
