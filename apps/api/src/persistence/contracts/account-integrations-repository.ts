/** Display-only metadata. Credential hashes, tokens and client secrets are excluded. */
export type IntegrationApiKey = {
  id: string; config_id: string; name: string | null; start: string | null;
  prefix: string | null; permissions: string | null;
  last_used_at: Date | null; created_at: Date;
};
export type ConnectedApp = {
  id: string; client_id: string; client_name: string | null; scopes: string[]; created_at: Date | null;
};
export interface AccountIntegrationsRepository {
  listApiKeys(userId: string): Promise<IntegrationApiKey[]>;
  listConnectedApps(userId: string): Promise<ConnectedApp[]>;
}
