export type ManagementIdentity = { issuer: string; clientId: string; deploymentId: string };
export type ManagementAccess = { systemAdmin: boolean; connectionActive: boolean | null };
export type ManagementContext = {
  connection: { owned: boolean; active: boolean | null };
  permissions: { account: boolean; billing: boolean; systemAdmin: boolean };
};

/** Recovery remains available to the owner of a disconnected connection. */
export function managementContextView(access: ManagementAccess | null, billingAvailable: () => boolean): ManagementContext | null {
  if (!access) return null;
  const owned = access.connectionActive !== null;
  return { connection: { owned, active: access.connectionActive },
    permissions: { account: owned, billing: owned && billingAvailable(), systemAdmin: access.systemAdmin } };
}

/** Management system authority deliberately requires the exact role value;
 * the native administration API's comma-token role rule is a separate contract. */
export function managementSystemAdministrator(role: string | null): boolean {
  return role === 'admin';
}
export function managementConnectionActive<Predicate>(installation: Predicate, teacher: Predicate,
  logic: { and(left: Predicate, right: Predicate): Predicate }): Predicate {
  return logic.and(installation, teacher);
}
