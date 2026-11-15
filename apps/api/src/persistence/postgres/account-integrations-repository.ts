import { and, desc, eq, inArray } from 'drizzle-orm';
import { withDb } from '../../db/pool';
import { apikey, oauthClient, oauthConsent } from '../../db/schema';
import type { Bindings } from '../../types/bindings';
import type { AccountIntegrationsRepository } from '../contracts/account-integrations-repository';

export function createPostgresAccountIntegrationsRepository(env: Bindings): AccountIntegrationsRepository {
  return {
    listApiKeys: userId => withDb(env, db => db.select({
      id: apikey.id, config_id: apikey.configId, name: apikey.name,
      start: apikey.start, prefix: apikey.prefix, permissions: apikey.permissions,
      last_used_at: apikey.lastRequest, created_at: apikey.createdAt,
    }).from(apikey).where(and(eq(apikey.referenceId, userId), inArray(apikey.configId, ['default', 'read-write'])))
      .orderBy(desc(apikey.createdAt), apikey.id)),
    listConnectedApps: userId => withDb(env, db => db.select({
      id: oauthConsent.id, client_id: oauthConsent.clientId, client_name: oauthClient.name,
      scopes: oauthConsent.scopes, created_at: oauthConsent.createdAt,
    }).from(oauthConsent).leftJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
      .where(eq(oauthConsent.userId, userId)).orderBy(desc(oauthConsent.createdAt), oauthConsent.id)),
  };
}
