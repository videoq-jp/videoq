/** Account identifiers are submitted trimmed and compared without case. */
export function accountIdentifierEdit(currentValue: string, draft: string) {
  const value = draft.trim();
  return { value, unchanged: value.toLowerCase() === currentValue.toLowerCase() };
}

/** Disconnecting an OAuth app revokes all of its grants across resources. */
export function remainingConnectedAppGrants<Grant extends { client_id: string }>(
  grants: Grant[] | undefined, revokedClientId: string,
): Grant[] | undefined {
  return grants?.filter(grant => grant.client_id !== revokedClientId);
}
