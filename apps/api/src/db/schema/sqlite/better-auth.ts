// SQLite / D1 schema. PostgreSQL history is maintained independently.
import { sqliteTable, text, integer, index, uniqueIndex, foreignKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { isoDate } from "./columns";
import { users } from "./modern";
/**
 * Better Auth always writes JS `Date` for `type: "date"` fields.
 * Official adapter schemas use Drizzle's default `mode: "date"` (not `"string"`).
 */
const baTimestamp = (name: string) => isoDate(name);
/** Better Auth session (cookie session). */
export const session = sqliteTable("session", {
    id: text("id").primaryKey(),
    expiresAt: baTimestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: baTimestamp("created_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: baTimestamp("updated_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id").notNull(),
    impersonatedBy: text("impersonated_by"),
}, (table) => [
    index("session_user_id_idx").on(table.userId),
    foreignKey({
        columns: [table.userId],
        foreignColumns: [users.id],
        name: "session_user_id_fkey",
    }).onDelete("cascade"),
]);
/** Better Auth account (credential password lives here). */
export const account = sqliteTable("account", {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    // Retain historical 1.7.0-1.7.2 values; newer Better Auth versions
    // identify accounts by providerId/accountId and no longer write issuer.
    issuer: text("issuer"),
    userId: text("user_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: baTimestamp("access_token_expires_at"),
    refreshTokenExpiresAt: baTimestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: baTimestamp("created_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: baTimestamp("updated_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, (table) => [
    index("account_user_id_idx").on(table.userId),
    index("account_provider_account_id_idx").on(table.providerId, table.accountId),
    foreignKey({
        columns: [table.userId],
        foreignColumns: [users.id],
        name: "account_user_id_fkey",
    }).onDelete("cascade"),
]);
/** Better Auth verification (email verify / password reset). */
export const verification = sqliteTable("verification", {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: baTimestamp("expires_at").notNull(),
    createdAt: baTimestamp("created_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: baTimestamp("updated_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});
/** Better Auth API keys (@better-auth/api-key). */
export const apikey = sqliteTable("apikey", {
    id: text("id").primaryKey(),
    configId: text("config_id").notNull().default("default"),
    name: text("name"),
    start: text("start"),
    referenceId: text("reference_id").notNull(),
    prefix: text("prefix"),
    key: text("key").notNull(),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: baTimestamp("last_refill_at"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    rateLimitEnabled: integer("rate_limit_enabled", { mode: "boolean" }),
    rateLimitTimeWindow: integer("rate_limit_time_window"),
    rateLimitMax: integer("rate_limit_max"),
    requestCount: integer("request_count"),
    remaining: integer("remaining"),
    lastRequest: baTimestamp("last_request"),
    expiresAt: baTimestamp("expires_at"),
    createdAt: baTimestamp("created_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: baTimestamp("updated_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    permissions: text("permissions"),
    metadata: text("metadata"),
}, (table) => [
    index("apikey_reference_id_idx").on(table.referenceId),
    index("apikey_key_idx").on(table.key),
]);
/** JWT plugin JWKS storage. */
export const jwks = sqliteTable("jwks", {
    id: text("id").primaryKey(),
    publicKey: text("public_key").notNull(),
    privateKey: text("private_key").notNull(),
    createdAt: baTimestamp("created_at").notNull().default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    expiresAt: baTimestamp("expires_at"),
    alg: text("alg"),
    crv: text("crv"),
});
/** Device authorization (RFC 8628). */
export const deviceCode = sqliteTable("device_code", {
    id: text("id").primaryKey(),
    deviceCode: text("device_code").notNull(),
    userCode: text("user_code").notNull(),
    userId: text("user_id"),
    expiresAt: baTimestamp("expires_at").notNull(),
    status: text("status").notNull(),
    lastPolledAt: baTimestamp("last_polled_at"),
    pollingInterval: integer("polling_interval"),
    clientId: text("client_id"),
    scope: text("scope"),
}, (table) => [
    uniqueIndex("device_code_device_code_uidx").on(table.deviceCode),
    index("device_code_user_code_idx").on(table.userCode),
]);
/** Better Auth serializes SQLite JSON/arrays itself; use plain TEXT to avoid double encoding. */
/** OAuth 2.1 provider clients. */
export const oauthClient = sqliteTable("oauth_client", {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    disabled: integer("disabled", { mode: "boolean" }).default(false),
    skipConsent: integer("skip_consent", { mode: "boolean" }),
    enableEndSession: integer("enable_end_session", { mode: "boolean" }),
    subjectType: text("subject_type"),
    scopes: text("scopes"),
    clientCredentialsScopes: text("client_credentials_scopes"),
    userId: text("user_id"),
    createdAt: baTimestamp("created_at").default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: baTimestamp("updated_at").default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts"),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris"),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: integer("backchannel_logout_session_required", { mode: "boolean" }),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("client_jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types"),
    responseTypes: text("response_types"),
    public: integer("public", { mode: "boolean" }),
    type: text("type"),
    requirePKCE: integer("require_pkce", { mode: "boolean" }),
    dpopBoundAccessTokens: integer("dpop_bound_access_tokens", { mode: "boolean" }).notNull()
        .default(false),
    referenceId: text("reference_id"),
    metadata: text("metadata"),
}, (table) => [
    index("oauth_client_user_id_idx").on(table.userId),
    foreignKey({
        columns: [table.userId],
        foreignColumns: [users.id],
        name: "oauth_client_user_id_fkey",
    }).onDelete("set null"),
]);
/** Protected resources for RFC 8707 resource-bound access tokens. */
export const oauthResource = sqliteTable("oauth_resource", {
    id: text("id").primaryKey(),
    identifier: text("identifier")
        .notNull()
        .unique("oauth_resource_identifier_key"),
    name: text("name").notNull(),
    accessTokenTtl: integer("access_token_ttl"),
    refreshTokenTtl: integer("refresh_token_ttl"),
    signingAlgorithm: text("signing_algorithm"),
    signingKeyId: text("signing_key_id"),
    allowedScopes: text("allowed_scopes"),
    customClaims: text("custom_claims"),
    dpopBoundAccessTokensRequired: integer("dpop_bound_access_tokens_required", { mode: "boolean" }).notNull()
        .default(false),
    disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
    createdAt: baTimestamp("created_at").default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: baTimestamp("updated_at").default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    policyVersion: integer("policy_version").notNull().default(1),
    metadata: text("metadata"),
});
/** OAuth client-to-resource allowlist. */
export const oauthClientResource = sqliteTable("oauth_client_resource", {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    resourceId: text("resource_id").notNull(),
    metadata: text("metadata"),
    createdAt: baTimestamp("created_at").default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, (table) => [
    index("oauth_client_resource_client_id_idx").on(table.clientId),
    index("oauth_client_resource_resource_id_idx").on(table.resourceId),
    uniqueIndex("oauth_client_resource_client_resource_uidx").on(table.clientId, table.resourceId),
    foreignKey({
        columns: [table.clientId],
        foreignColumns: [oauthClient.clientId],
        name: "oauth_client_resource_client_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
        columns: [table.resourceId],
        // Better Auth stores the RFC 8707 resource identifier (the URL),
        // not oauth_resource's internal row id, in this join table.
        foreignColumns: [oauthResource.identifier],
        name: "oauth_client_resource_resource_id_fkey",
    }).onDelete("cascade"),
]);
export const oauthRefreshToken = sqliteTable("oauth_refresh_token", {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id").notNull(),
    sessionId: text("session_id"),
    userId: text("user_id").notNull(),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources"),
    requestedUserInfoClaims: text("requested_user_info_claims"),
    expiresAt: baTimestamp("expires_at"),
    createdAt: baTimestamp("created_at").default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    revoked: baTimestamp("revoked"),
    rotatedAt: baTimestamp("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: baTimestamp("rotation_replay_expires_at"),
    authTime: baTimestamp("auth_time"),
    confirmation: text("confirmation"),
    scopes: text("scopes").notNull(),
}, (table) => [
    index("oauth_refresh_token_user_id_idx").on(table.userId),
    index("oauth_refresh_token_client_id_idx").on(table.clientId),
    index("oauth_refresh_token_session_id_idx").on(table.sessionId),
    index("oauth_refresh_token_authorization_code_id_idx").on(table.authorizationCodeId),
    foreignKey({
        columns: [table.userId],
        foreignColumns: [users.id],
        name: "oauth_refresh_token_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
        columns: [table.clientId],
        foreignColumns: [oauthClient.clientId],
        name: "oauth_refresh_token_client_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
        columns: [table.sessionId],
        foreignColumns: [session.id],
        name: "oauth_refresh_token_session_id_fkey",
    }).onDelete("set null"),
]);
export const oauthAccessToken = sqliteTable("oauth_access_token", {
    id: text("id").primaryKey(),
    token: text("token").unique(),
    clientId: text("client_id").notNull(),
    sessionId: text("session_id"),
    userId: text("user_id"),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources"),
    requestedUserInfoClaims: text("requested_user_info_claims"),
    refreshId: text("refresh_id"),
    expiresAt: baTimestamp("expires_at"),
    createdAt: baTimestamp("created_at").default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    revoked: baTimestamp("revoked"),
    confirmation: text("confirmation"),
    scopes: text("scopes").notNull(),
}, (table) => [
    index("oauth_access_token_user_id_idx").on(table.userId),
    index("oauth_access_token_client_id_idx").on(table.clientId),
    index("oauth_access_token_session_id_idx").on(table.sessionId),
    index("oauth_access_token_authorization_code_id_idx").on(table.authorizationCodeId),
    index("oauth_access_token_refresh_id_idx").on(table.refreshId),
    foreignKey({
        columns: [table.userId],
        foreignColumns: [users.id],
        name: "oauth_access_token_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
        columns: [table.clientId],
        foreignColumns: [oauthClient.clientId],
        name: "oauth_access_token_client_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
        columns: [table.sessionId],
        foreignColumns: [session.id],
        name: "oauth_access_token_session_id_fkey",
    }).onDelete("set null"),
    foreignKey({
        columns: [table.refreshId],
        foreignColumns: [oauthRefreshToken.id],
        name: "oauth_access_token_refresh_id_fkey",
    }),
]);
export const oauthConsent = sqliteTable("oauth_consent", {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    userId: text("user_id"),
    referenceId: text("reference_id"),
    resources: text("resources"),
    requestedUserInfoClaims: text("requested_user_info_claims"),
    scopes: text("scopes").notNull(),
    createdAt: baTimestamp("created_at").default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: baTimestamp("updated_at").default(sql `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
}, (table) => [
    index("oauth_consent_user_id_idx").on(table.userId),
    foreignKey({
        columns: [table.userId],
        foreignColumns: [users.id],
        name: "oauth_consent_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
        columns: [table.clientId],
        foreignColumns: [oauthClient.clientId],
        name: "oauth_consent_client_id_fkey",
    }).onDelete("cascade"),
]);
/** One-time private_key_jwt client assertion ids. */
export const oauthClientAssertion = sqliteTable("oauth_client_assertion", {
    id: text("id").primaryKey(),
    expiresAt: baTimestamp("expires_at").notNull(),
});
