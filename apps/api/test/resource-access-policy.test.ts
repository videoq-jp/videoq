import { describe, expect, it } from 'vitest';
import { accountIsBanned, apiKeyResourceAccess, defaultApiKeyPermissions, oauthResourceAccess, parseResourceScopes } from '../src/domain/lms/resource-access';

describe('verified resource credential policy', () => {
  it('checks current API-key owner status before evaluating write permission', () => {
    const unavailablePermission = () => { throw new Error('Permissions must not be parsed'); };
    expect(apiKeyResourceAccess(null, unavailablePermission, 0)).toEqual({ kind: 'invalid', message: 'User is inactive' });
    expect(apiKeyResourceAccess({ id: 'user', banned: true }, unavailablePermission, 0).kind).toBe('invalid');
    expect(apiKeyResourceAccess({ id: 'user', banned: true, banExpires: new Date(-1) }, () => true, 0)).toEqual({
      kind: 'ok', userId: 'user', via: 'apikey', accessLevel: 'all',
    });
    expect(apiKeyResourceAccess({ id: 'user' }, () => false, 0)).toEqual({ kind: 'ok', userId: 'user', via: 'apikey', accessLevel: 'read_only' });
    expect(defaultApiKeyPermissions('default')).toEqual({ videoq: ['read'] });
    expect(defaultApiKeyPermissions('read-write')).toEqual({ videoq: ['read', 'write'] });
  });
  it('keeps bans active at their exact expiry and rejects invalid expiry dates', () => {
    const now = Date.parse('2026-11-20T00:00:00Z');
    expect(accountIsBanned({ banned: true, banExpires: new Date(now) }, now)).toBe(true);
    expect(accountIsBanned({ banned: true, banExpires: new Date(now - 1).toISOString() }, now)).toBe(false);
    expect(accountIsBanned({ banned: true, banExpires: 'invalid' }, now)).toBe(true);
    expect(accountIsBanned({ banned: true }, now)).toBe(true);
    expect(accountIsBanned({ banned: false, banExpires: 'invalid' }, now)).toBe(false);
  });

  it('distinguishes absent scope from malformed scope without normalizing credentials', () => {
    expect(parseResourceScopes(undefined)).toEqual([]);
    expect(parseResourceScopes('videoq.read videoq.write')).toEqual(['videoq.read', 'videoq.write']);
    for (const scope of [null, [], '', ' videoq.read', 'videoq.read ', 'videoq.read  videoq.write', 'videoq.read\tvideoq.write', 'videoq.read"', 'videoq.read\\', '日本語']) {
      expect(parseResourceScopes(scope)).toBeNull();
    }
  });

  it('checks account status before scope and requires read permission even for writers', () => {
    expect(oauthResourceAccess('user', null, [], 0)).toEqual({ kind: 'invalid', message: 'User is inactive' });
    expect(oauthResourceAccess('user', { banned: true }, ['videoq.read', 'videoq.write'], 0).kind).toBe('invalid');
    expect(oauthResourceAccess('user', {}, ['videoq.write'], 0)).toEqual({
      kind: 'forbidden', message: 'OAuth token lacks videoq.read scope', requiredScope: 'videoq.read',
    });
    expect(oauthResourceAccess('user', {}, ['videoq.read'], 0)).toEqual({
      kind: 'ok', userId: 'user', via: 'oauth', accessLevel: 'read_only',
    });
    expect(oauthResourceAccess('user', {}, ['videoq.read', 'videoq.write'], 0)).toEqual({
      kind: 'ok', userId: 'user', via: 'oauth', accessLevel: 'all',
    });
  });
});
