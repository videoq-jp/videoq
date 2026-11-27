import { consentAllows, refreshConsentPlan, type ConsentScopeGrant, type RefreshConsentGrant } from '../../domain/identity/oauth-consent';
export type { RefreshConsentGrant } from '../../domain/identity/oauth-consent';
/** Each call reloads current consent so revocation is immediately effective. */
export async function currentConsentAllows(scopes: readonly string[], load: () => Promise<ConsentScopeGrant | null>): Promise<boolean> {
  return consentAllows(scopes, await load());
}
export async function refreshConsentDecision(grant: RefreshConsentGrant | null, requestedScope: unknown, hasConsent: (userId:string,clientId:string,scopes:readonly string[]) => Promise<boolean>): Promise<'provider' | 'allowed' | 'denied'> {
  const plan = refreshConsentPlan(grant, requestedScope);
  if (plan.kind !== 'check') return plan.kind;
  return await hasConsent(plan.userId, plan.clientId, plan.scopes) ? 'allowed' : 'denied';
}
