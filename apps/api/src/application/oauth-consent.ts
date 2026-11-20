export type ConsentScopeGrant = { scopes: readonly string[] };

/** Recheck the current consent; a previous grant must not cache removed scopes. */
export async function currentConsentAllows(
  scopes: readonly string[], load: () => Promise<ConsentScopeGrant | null>,
): Promise<boolean> {
  const consent = await load();
  return Boolean(consent && scopes.every(scope => consent.scopes.includes(scope)));
}

/** Only authorization metadata enters the workflow, never refresh credentials. */
export type RefreshConsentGrant = {
  revoked: boolean;
  userId?: string | null;
  clientId?: string | null;
  scopes: readonly string[];
};

export async function refreshConsentDecision(
  grant: RefreshConsentGrant | null, requestedScope: unknown,
  hasConsent: (userId: string, clientId: string, scopes: readonly string[]) => Promise<boolean>,
): Promise<'provider' | 'allowed' | 'denied'> {
  // The credential provider owns missing/replayed token handling and rotation.
  if (!grant || grant.revoked) return 'provider';
  if (!grant.userId || !grant.clientId) return 'denied';
  const scopes = typeof requestedScope === 'string' ? requestedScope.split(' ') : grant.scopes;
  return await hasConsent(grant.userId, grant.clientId, scopes) ? 'allowed' : 'denied';
}
