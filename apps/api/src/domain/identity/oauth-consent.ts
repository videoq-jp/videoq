export type ConsentScopeGrant = { scopes: readonly string[] };
/** Current facts, never a cached previous grant, determine available scopes. */
export function consentAllows(scopes: readonly string[], consent: ConsentScopeGrant | null): boolean {
  return Boolean(consent && scopes.every(scope => consent.scopes.includes(scope)));
}
export type RefreshConsentGrant = {
  revoked: boolean; userId?: string | null; clientId?: string | null; scopes: readonly string[];
};
export type RefreshConsentPlan = {kind:'provider' | 'denied'} | {kind:'check';userId:string;clientId:string;scopes:readonly string[]};
/** The provider owns replay/missing credential handling; no credentials enter here. */
export function refreshConsentPlan(grant: RefreshConsentGrant | null, requestedScope: unknown): RefreshConsentPlan {
  if (!grant || grant.revoked) return {kind:'provider'};
  if (!grant.userId || !grant.clientId) return {kind:'denied'};
  return {kind:'check',userId:grant.userId,clientId:grant.clientId,scopes:typeof requestedScope === 'string' ? requestedScope.split(' ') : grant.scopes};
}
