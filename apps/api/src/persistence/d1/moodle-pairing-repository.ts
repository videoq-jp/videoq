import {
  and,
  or,
  eq,
  ne,
  inArray,
  exists,
  notExists,
  sql,
  type SQL,
} from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import {
  insertSelectValues,
  runD1Batch,
  type D1Query,
} from "../../db/d1/query-builders";
import {
  users,
  ltiCredentials as credentials,
  ltiToolKeys as keys,
  lmsInstallations as installations,
  mutationReceipts as receipts,
} from "../../db/schema/sqlite";
import {
  pairingMaterialsUnavailable,
  pairingCanReplay,
  matchingPairingPayload,
  pairingConnectionConflict,
  pairingInstallationFields,
  pairingSyncTokenHash,
  pairingExpiry,
  pairingExchangeAllowed,
  pairingExchangeFailure,
} from "../../domain/lms/pairing-exchange";
import { pairingDrizzleLogic as logic } from "../pairing-policy-sql";
import { activeD1LmsOwner } from "./lms-owner-policy";
import type { Bindings } from "../../types/bindings";
import type { MoodlePairingRepository } from "../contracts/moodle-pairing-repository";
import { LmsSyncError } from "../../features/lms/resource";
import { ltiMaterialsEnabled } from "../../features/lti/config";
import { digest } from "../../features/lti/store";
import { hasSecretEncryptionKey } from "../../lib/secret-encryption";
import {
  identity,
  parseKeys,
  parseStoredToolKeyRing,
  generateEncryptedToolKeyRing,
} from "../../shared/lti-tool-keyring";
import {
  pairingPayloadSchema,
  requireProof,
} from "../../shared/moodle-pairing-policy";
export function createD1MoodlePairingRepository(
  database: D1Database,
  env: Bindings,
): MoodlePairingRepository {
  const db = createD1Connection(database);
  const activeOwner = (id: string | null) =>
    exists(
      db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, sql`${id}`), activeD1LmsOwner())),
    );
  const gate = (token: string) =>
    exists(
      db
        .select({ token: receipts.token })
        .from(receipts)
        .where(eq(receipts.token, token)),
    );
  const receiptInsert = (token: string, kind: string, condition: SQL) =>
    db.insert(receipts).select(
      db
        .select(insertSelectValues(receipts, { token, kind, resourceId: 0 }))
        .from(sql`(VALUES(1)) input`)
        .where(condition),
    );
  const live = (id: string, kind: string) =>
    and(
      eq(credentials.id, id),
      eq(credentials.kind, kind),
      sql`julianday(${credentials.expiresAt})>julianday('now')`,
    );
  return {
    async issue(input) {
      if (
        !(await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, input.ownerUserId), activeD1LmsOwner()))
          .get())
      )
        throw new LmsSyncError(403, "INACTIVE_ACCOUNT");
      // A competing initializer may win during RSA generation. Losing batches write
      // neither pairing code nor pointer; retry only the stored-key comparison.
      for (let attempt = 0; attempt < 3; attempt++) {
        let encrypted: string | null = null,
          candidate = false;
        if (input.payload.mode === "materials") {
          if (env.LTI_TOOL_KEYS?.trim()) parseKeys(env.LTI_TOOL_KEYS);
          else {
            if (!hasSecretEncryptionKey(env))
              throw new Error("LTI signing keys are unavailable");
            try {
              encrypted =
                (
                  await db
                    .select({ encrypted: keys.encryptedKeyRing })
                    .from(keys)
                    .where(eq(keys.id, identity))
                    .get()
                )?.encrypted ?? null;
              if (encrypted) await parseStoredToolKeyRing(env, encrypted);
              else {
                encrypted = await generateEncryptedToolKeyRing(env);
                candidate = true;
              }
            } catch {
              throw new Error("LTI signing-key initialization failed");
            }
          }
        }
        const token = crypto.randomUUID(),
          owner = activeOwner(input.ownerUserId);
        const guard = and(
          owner,
          encrypted
            ? exists(
                db
                  .select({ id: keys.id })
                  .from(keys)
                  .where(
                    and(
                      eq(keys.id, identity),
                      eq(keys.encryptedKeyRing, encrypted),
                    ),
                  ),
              )
            : undefined,
        )!;
        // Mixed insert/select batch has a variable optional key initializer. Compile
        // builders once and keep the outcome read inside this same atomic batch.
        const batch: D1Query[] = [];
        if (candidate)
          batch.push(
            db
              .insert(keys)
              .select(
                db
                  .select(
                    insertSelectValues(keys, {
                      id: identity,
                      encryptedKeyRing: sql`${encrypted}`,
                    }),
                  )
                  .from(users)
                  .where(
                    and(eq(users.id, input.ownerUserId), activeD1LmsOwner()),
                  ),
              )
              .onConflictDoNothing({ target: keys.id }),
          );
        batch.push(
          receiptInsert(token, "pairing_issue", guard),
          db
            .delete(credentials)
            .where(
              and(
                eq(credentials.id, input.ownerKey),
                eq(credentials.kind, "moodle-pairing"),
                gate(token),
              ),
            ),
          db.insert(credentials).select(
            db
              .select(
                insertSelectValues(credentials, {
                  id: input.codeHash,
                  kind: "moodle-pairing-code",
                  payload: input.payload,
                  expiresAt: new Date(input.expiresAt),
                }),
              )
              .from(receipts)
              .where(eq(receipts.token, token)),
          ),
          db.insert(credentials).select(
            db
              .select(
                insertSelectValues(credentials, {
                  id: input.ownerKey,
                  kind: "moodle-pairing",
                  payload: { codeHash: input.codeHash },
                  expiresAt: new Date(input.expiresAt),
                }),
              )
              .from(receipts)
              .where(eq(receipts.token, token)),
          ),
          db
            .select({
              issued: gate(token).as("issued"),
              active: owner.as("active"),
            })
            .from(sql`(VALUES(1)) input`),
          db.delete(receipts).where(eq(receipts.token, token)),
        );
        const result = await runD1Batch<{ issued: number; active: number }>(
            database,
            batch,
          ),
          row = result[result.length - 2].results[0];
        if (row.issued) return;
        if (!row.active) throw new LmsSyncError(403, "INACTIVE_ACCOUNT");
      }
      throw new Error("LTI signing-key initialization failed");
    },
    async exchange(input, codeHash, receiptId) {
      if (pairingMaterialsUnavailable(input.mode, ltiMaterialsEnabled(env)))
        throw new LmsSyncError(403, "LTI_MATERIALS_DISABLED");
      const snapshots = await db.batch([
        db
          .select({ payload: sql<string>`${credentials.payload}` })
          .from(credentials)
          .where(live(receiptId, "materials-pairing")),
        db
          .select({ payload: sql<string>`${credentials.payload}` })
          .from(credentials)
          .where(live(codeHash, "moodle-pairing-code")),
      ]);
      const receiptRaw = snapshots[0][0]?.payload,
        receipt = receiptRaw
          ? (JSON.parse(receiptRaw) as Record<string, unknown>)
          : null,
        canReplay = pairingCanReplay(input, receipt);
      const rawCode = snapshots[1][0]?.payload,
        parsed = pairingPayloadSchema.safeParse(
          rawCode ? JSON.parse(rawCode) : undefined,
        ),
        payload = matchingPairingPayload(
          parsed.success ? parsed.data : null,
          input,
        );
      if (!canReplay && !payload)
        throw new LmsSyncError(401, "INVALID_PAIRING_CODE");
      const challenge = canReplay
        ? receipt!.codeChallenge
        : payload!.codeChallenge;
      await requireProof(challenge, input.codeVerifier);
      const ownerId = payload?.ownerUserId ?? null,
        ownerKey = ownerId
          ? await digest("moodle-pairing-owner:" + ownerId)
          : "";
      const replay =
        input.mode === "materials"
          ? exists(
              db
                .select({ id: credentials.id })
                .from(credentials)
                .where(
                  and(
                    live(receiptId, "materials-pairing"),
                    eq(
                      sql`json_extract(${credentials.payload},'$.issuer')`,
                      input.issuer,
                    ),
                    eq(
                      sql`json_extract(${credentials.payload},'$.clientId')`,
                      input.clientId,
                    ),
                    eq(
                      sql`json_extract(${credentials.payload},'$.deploymentId')`,
                      input.deploymentId,
                    ),
                    sql`json_extract(${credentials.payload},'$.codeChallenge') IS ${challenge ?? null}`,
                    canReplay
                      ? eq(sql`${credentials.payload}`, receiptRaw)
                      : undefined,
                  ),
                ),
            )
          : sql`0`;
      const connection = exists(
        db
          .select({ id: installations.id })
          .from(installations)
          .innerJoin(users, eq(users.id, installations.ownerUserId))
          .innerJoin(credentials, eq(credentials.id, receiptId))
          .where(
            and(
              eq(
                installations.id,
                sql`json_extract(${credentials.payload},'$.installationId')`,
              ),
              eq(installations.active, true),
              activeD1LmsOwner(),
              canReplay || ownerId === null ? undefined : eq(users.id, ownerId),
            ),
          ),
      );
      const code = payload
        ? exists(
            db
              .select({ id: credentials.id })
              .from(credentials)
              .where(
                and(
                  live(codeHash, "moodle-pairing-code"),
                  eq(sql`${credentials.payload}`, rawCode),
                ),
              ),
          )
        : sql`0`;
      const active = activeOwner(ownerId),
        pointer = exists(
          db
            .select({ id: credentials.id })
            .from(credentials)
            .where(
              and(
                live(ownerKey, "moodle-pairing"),
                eq(
                  sql`json_extract(${credentials.payload},'$.codeHash')`,
                  codeHash,
                ),
              ),
            ),
        );
      const identityMatches = and(
        eq(installations.issuer, input.issuer),
        eq(installations.clientId, input.clientId),
      );
      const ownerConflict = pairingConnectionConflict(
        input.mode,
        ne(installations.ownerUserId, sql`${ownerId}`),
        logic,
      );
      const conflict = exists(
        db
          .select({ id: installations.id })
          .from(installations)
          .where(and(identityMatches, ownerConflict)),
      );
      const eligible = pairingExchangeAllowed(
          { code, active, pointer, replay, conflict },
          logic,
        ),
        token = crypto.randomUUID(),
        replayToken = token + ":replay",
        candidateId = crypto.randomUUID();
      const syncHash = await pairingSyncTokenHash(input, digest),
        installation = pairingInstallationFields(input);
      const fields = {
        name: input.issuer,
        deploymentId: input.deploymentId,
        authorizationUrl: installation.authorizationUrl,
        jwksUrl: installation.jwksUrl,
        syncTokenHash: syncHash,
        materialsService: input.materialsService ?? null,
      };
      const receiptInstallation = db
        .select({
          id: sql<string>`json_extract(${credentials.payload},'$.installationId')`,
        })
        .from(credentials)
        .where(eq(credentials.id, receiptId));
      const flags = await db.batch([
        db
          .select({
            replay: replay.as("replay"),
            connected: connection.as("connected"),
            code: code.as("code"),
            active: active.as("active"),
            pointer: pointer.as("pointer"),
            conflict: conflict.as("conflict"),
          })
          .from(sql`(VALUES(1)) input`),
        receiptInsert(replayToken, "pairing_replay", and(replay, connection)!),
        receiptInsert(token, "pairing_exchange", eligible),
        db
          .update(installations)
          .set({ ...fields, active: true })
          .where(
            and(
              identityMatches,
              eq(installations.ownerUserId, sql`${ownerId}`),
              sql`${input.mode}='materials'`,
              gate(token),
            ),
          ),
        db.insert(installations).select(
          db
            .select(
              insertSelectValues(installations, {
                id: candidateId,
                ownerUserId: sql`${ownerId}`,
                issuer: input.issuer,
                clientId: input.clientId,
                ...fields,
              }),
            )
            .from(receipts)
            .where(
              and(
                eq(receipts.token, token),
                notExists(
                  db
                    .select({ id: installations.id })
                    .from(installations)
                    .where(identityMatches),
                ),
              ),
            ),
        ),
        db.insert(credentials).select(
          db
            .select(
              insertSelectValues(credentials, {
                id: receiptId,
                kind: "materials-pairing",
                payload: sql`json_patch(json_object('installationId',${installations.id},'issuer',${input.issuer},'clientId',${input.clientId},'deploymentId',${input.deploymentId}),${JSON.stringify(challenge ? { codeChallenge: challenge } : {})})`,
                expiresAt: pairingExpiry(Date.now()),
              }),
            )
            .from(installations)
            .where(
              and(identityMatches, sql`${input.mode}='materials'`, gate(token)),
            ),
        ),
        db
          .delete(credentials)
          .where(
            and(inArray(credentials.id, [codeHash, ownerKey]), gate(token)),
          ),
        db
          .select({
            installationId: installations.id,
            ownerUserId: installations.ownerUserId,
          })
          .from(installations)
          .where(
            or(
              and(identityMatches, gate(token)),
              and(eq(installations.id, receiptInstallation), gate(replayToken)),
            ),
          ),
        db
          .delete(receipts)
          .where(inArray(receipts.token, [token, replayToken])),
      ]);
      const saved = flags[7][0];
      if (saved) return saved;
      const state = flags[0][0],
        failure = pairingExchangeFailure({
          replay: Boolean(state.replay),
          code: Boolean(state.code),
          active: Boolean(state.active),
          pointer: Boolean(state.pointer),
          conflict: Boolean(state.conflict),
        });
      if (failure)
        throw new LmsSyncError(
          failure === "INACTIVE_ACCOUNT"
            ? 403
            : failure === "CONNECTION_EXISTS"
              ? 409
              : 401,
          failure,
        );
      throw new Error("Pairing exchange did not commit");
    },
  };
}
