import { expect, it } from 'vitest';
import { createGoogleAccountProfile } from '../src/application/google-account';

const deps = { usernameExists: async () => false, newId: () => 'unused' };

it('trusts only a true verification claim with current Google mailbox authority', async () => {
  for (const [email, hostedDomain, expected] of [
    ['Owner@GMAIL.COM', undefined, true], ['owner@external.test', undefined, false],
    ['owner@external.test', '   ', false], ['owner@workspace.test', 'workspace.test', true],
  ] as const) {
    expect((await createGoogleAccountProfile({ email, hostedDomain, verifiedEmail: true }, deps)).emailVerified).toBe(expected);
  }
  for (const verifiedEmail of [false, undefined, 'true', 1]) {
    expect((await createGoogleAccountProfile({ email: 'owner@gmail.com', verifiedEmail }, deps)).emailVerified).toBe(false);
  }
});
it('preserves email and image bytes while trimming a display name and allocating a separate unique username', async () => {
  const checked: string[] = [];
  const result = await createGoogleAccountProfile({ email: 'Owner@GMAIL.COM', displayName: '  Display Name  ', image: '' }, {
    ...deps, usernameExists: async candidate => { checked.push(candidate); return candidate === 'owner'; },
  });
  expect(result).toEqual({ name: 'Display Name', email: 'Owner@GMAIL.COM', emailVerified: false, image: '', username: 'owner_1', displayUsername: 'owner_1' });
  expect(checked).toEqual(['owner', 'owner_1']);
});
it('uses the allocated identity when both profile email and name are absent', async () => {
  expect(await createGoogleAccountProfile({ image: 42 }, deps)).toEqual({
    name: 'user', email: '', emailVerified: false, image: undefined, username: 'user', displayUsername: 'user',
  });
});
