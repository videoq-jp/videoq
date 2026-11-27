import { expect, it, vi } from 'vitest';
import { allocateUniqueUsername } from '../src/domain/identity/username';

it('keeps a collision suffix within the username limit', async () => {
  const exists = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const newId = vi.fn();
  const name = await allocateUniqueUsername(exists, 'A'.repeat(150), newId);
  expect(name).toBe('a'.repeat(148) + '_1');
  expect(exists.mock.calls.map(([candidate]) => candidate)).toEqual(['a'.repeat(150), name]);
  expect(newId).not.toHaveBeenCalled();
});

it('tries at most fifty stable candidates before using the injected fallback identity', async () => {
  const exists = vi.fn().mockResolvedValue(true);
  const newId = vi.fn().mockReturnValue('12345678-abcd-4321-9876-123456789abc');
  await expect(allocateUniqueUsername(exists, 'Alice.Bob+tag@example.com', newId))
    .resolves.toBe('user_12345678abcd');
  expect(exists).toHaveBeenCalledTimes(50);
  expect(exists).toHaveBeenNthCalledWith(1, 'alice_bob_tag');
  expect(exists).toHaveBeenNthCalledWith(50, 'alice_bob_tag_49');
  expect(newId).toHaveBeenCalledOnce();
});

it('propagates lookup failure without creating a fallback identity', async () => {
  const failure = new Error('username lookup unavailable');
  const exists = vi.fn().mockRejectedValue(failure);
  const newId = vi.fn();
  await expect(allocateUniqueUsername(exists, 'a@example.com', newId)).rejects.toBe(failure);
  expect(exists).toHaveBeenCalledExactlyOnceWith('user_a');
  expect(newId).not.toHaveBeenCalled();
});
