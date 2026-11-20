import { describe, expect, it } from 'vitest';
import { adminRoleChangeFailure } from '../src/application/admin';

describe('account role assignment policy', () => {
  it('allows omitted roles and the two supported roles', () => {
    expect(adminRoleChangeFailure(undefined, 'actor', 'actor')).toBeUndefined();
    expect(adminRoleChangeFailure('admin', 'actor', 'actor')).toBeUndefined();
    expect(adminRoleChangeFailure('user', 'actor', 'other')).toBeUndefined();
    expect(adminRoleChangeFailure('user', undefined, undefined)).toBeUndefined();
  });
  it('rejects unsupported roles, including combined and array roles', () => {
    for (const role of ['staff', 'user,admin', ['user', 'admin'], [], null, 1]) {
      expect(adminRoleChangeFailure(role, 'actor', 'other')).toBe('Role must be user or admin.');
    }
  });
  it('prevents self-demotion without treating absent server actors as self', () => {
    expect(adminRoleChangeFailure('user', 'actor', 'actor')).toBe('Cannot remove your own administrator role.');
    expect(adminRoleChangeFailure('user', 'actor', undefined)).toBeUndefined();
    expect(adminRoleChangeFailure('user', undefined, undefined)).toBeUndefined();
  });
});
