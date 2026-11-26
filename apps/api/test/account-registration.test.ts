import { expect, it, vi } from 'vitest';
import { initializeAccount } from '../src/domain/identity/account-registration';

const quota = {
  maxVideoUploadSizeMb: 100, aiAnswersLimit: 0, processingLimitMinutes: null,
  storageLimitGb: 12, monthlyUploadLimitGb: null,
};

it('preserves supplied identity fields while enforcing fresh usage and configured quotas', async () => {
  const deps = { usernameExists: vi.fn(), newId: vi.fn() };
  const user = { email: 'alice@example.com', username: ' Alice ', displayUsername: ' Display ',
    name: ' ', emailVerified: true, firstName: 'untrusted', passwordResetRequired: true,
    usedAiAnswers: 99, aiAnswersLimit: 999, isOverQuota: true };
  await expect(initializeAccount(user, quota, deps)).resolves.toMatchObject({
    email: user.email, username: 'Alice', displayUsername: ' Display ', name: ' ',
    emailVerified: true, ...quota, firstName: '', lastName: '', passwordResetRequired: false,
    usedAiAnswers: 0, usedProcessingSeconds: 0, usedStorageBytes: 0, isOverQuota: false,
  });
  expect(deps.usernameExists).not.toHaveBeenCalled();
  expect(deps.newId).not.toHaveBeenCalled();
  expect(user.usedAiAnswers).toBe(99);
});

it('uses the allocated username for missing display identity without consuming a random ID', async () => {
  const deps = { usernameExists: vi.fn().mockResolvedValue(false), newId: vi.fn() };
  await expect(initializeAccount({ email: 'Alice.Bob@example.com', username: ' ', name: '' }, quota, deps))
    .resolves.toMatchObject({ username: 'alice_bob', displayUsername: 'alice_bob', name: 'alice_bob' });
  expect(deps.usernameExists).toHaveBeenCalledExactlyOnceWith('alice_bob');
  expect(deps.newId).not.toHaveBeenCalled();
});

it('does not produce an initialized account after uniqueness lookup fails', async () => {
  const failure = new Error('lookup unavailable');
  const deps = { usernameExists: vi.fn().mockRejectedValue(failure), newId: vi.fn() };
  await expect(initializeAccount({ email: 'alice@example.com' }, quota, deps)).rejects.toBe(failure);
  expect(deps.newId).not.toHaveBeenCalled();
});
