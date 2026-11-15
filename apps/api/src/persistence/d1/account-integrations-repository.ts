import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { z } from 'zod';
import { apikey, oauthClient, oauthConsent } from '../../db/schema/sqlite/better-auth';
import type { AccountIntegrationsRepository } from '../contracts/account-integrations-repository';

export function createD1AccountIntegrationsRepository(database: D1Database): AccountIntegrationsRepository {
  const db = drizzle(database);
  return {
    listApiKeys: userId => db.select({
      id: apikey.id, config_id: apikey.configId, name: apikey.name,
      start: apikey.start, prefix: apikey.prefix, permissions: apikey.permissions,
      last_used_at: apikey.lastRequest, created_at: apikey.createdAt,
    }).from(apikey).where(and(eq(apikey.referenceId, userId), inArray(apikey.configId, ['default', 'read-write'])))
      .orderBy(desc(apikey.createdAt), apikey.id).all(),
    async listConnectedApps(userId) {
      const rows = await db.select({
        id: oauthConsent.id, client_id: oauthConsent.clientId, client_name: oauthClient.name,
        scopes: oauthConsent.scopes, created_at: oauthConsent.createdAt,
      }).from(oauthConsent).leftJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
        .where(eq(oauthConsent.userId, userId))
        // PostgreSQL DESC places unknown issue dates first; preserve that contract.
        .orderBy(desc(sql`${oauthConsent.createdAt} IS NULL`), desc(oauthConsent.createdAt), oauthConsent.id).all();
      return rows.map(row => ({ ...row, scopes: z.array(z.string()).parse(JSON.parse(row.scopes)) }));
    },
  };
}
