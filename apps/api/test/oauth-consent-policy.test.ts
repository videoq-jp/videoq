import { expect, it, vi } from 'vitest';
import { currentConsentAllows, refreshConsentDecision, type RefreshConsentGrant } from '../src/application/oauth-consent';

const grant: RefreshConsentGrant = {
  revoked: false, userId: 'owner', clientId: 'client', scopes: ['videoq.read', 'videoq.write'],
};

it.each([null, { ...grant, revoked: true }])('defers missing or consumed credentials to native rotation handling', async token => {
  const hasConsent = vi.fn();
  await expect(refreshConsentDecision(token, undefined, hasConsent)).resolves.toBe('provider');
  expect(hasConsent).not.toHaveBeenCalled();
});

it.each([{ ...grant, userId: null }, { ...grant, clientId: undefined }])('rejects incomplete grant identities before looking up consent', async token => {
  const hasConsent = vi.fn();
  await expect(refreshConsentDecision(token, undefined, hasConsent)).resolves.toBe('denied');
  expect(hasConsent).not.toHaveBeenCalled();
});

it('checks explicitly narrowed scopes instead of the original token scopes', async () => {
  const hasConsent = vi.fn().mockResolvedValue(true);
  await expect(refreshConsentDecision(grant, 'videoq.read', hasConsent)).resolves.toBe('allowed');
  expect(hasConsent).toHaveBeenCalledExactlyOnceWith('owner', 'client', ['videoq.read']);
});

it('uses the original scopes when no textual scope is supplied and preserves denial', async () => {
  const hasConsent = vi.fn().mockResolvedValue(false);
  await expect(refreshConsentDecision(grant, undefined, hasConsent)).resolves.toBe('denied');
  expect(hasConsent).toHaveBeenCalledExactlyOnceWith('owner', 'client', grant.scopes);
});

it('does not silently repair invalid scope separators before native validation', async () => {
  const hasConsent = vi.fn().mockResolvedValue(false);
  await refreshConsentDecision(grant, 'videoq.read  videoq.write', hasConsent);
  expect(hasConsent).toHaveBeenCalledExactlyOnceWith('owner', 'client', ['videoq.read', '', 'videoq.write']);
});

it('rereads current consent so removing a scope or consent prevents renewal', async () => {
  const load = vi.fn().mockResolvedValueOnce({ scopes: grant.scopes })
    .mockResolvedValueOnce({ scopes: ['videoq.read'] }).mockResolvedValueOnce(null);
  await expect(currentConsentAllows(grant.scopes, load)).resolves.toBe(true);
  await expect(currentConsentAllows(grant.scopes, load)).resolves.toBe(false);
  await expect(currentConsentAllows([], load)).resolves.toBe(false);
});

it('propagates unavailable consent storage instead of allowing a refresh', async () => {
  const failure = new Error('consent unavailable');
  await expect(refreshConsentDecision(grant, undefined, () => Promise.reject(failure))).rejects.toBe(failure);
});
