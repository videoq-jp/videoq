import { and, eq, gt, isNotNull, sql } from "drizzle-orm";
import { union } from "drizzle-orm/sqlite-core";
import { runD1Batch, type D1Query } from "../../db/d1/query-builders";
import {
  lmsCourses,
  teachingConnections,
  ltiCredentials,
} from "../../db/schema/sqlite";
import {
  privacyCatalogPage,
  privacySubjectsWithData,
  privacyCursorFailure,
  privacyRecordCursor,
} from '../../domain/lms/privacy-policy';
import {
  PRIVACY_CONTEXT_PAGE_SIZE,
  privacyContextCollections,
  privacyContextPage,
  privacyExportPage,
  PRIVACY_EXPORT_CHUNK_CHARACTERS,
} from '../../domain/lms/privacy';
import { z } from "zod";
import { ApiError } from "../../shared/errors";
import {
  privacySubject,
  privacyRequest,
  type PrivacySubject,
  type PrivacyInstallation,
} from "../../shared/privacy";
import { digest } from "../../features/lti/store";
import {
  privacyReadQueries,
  binaryNames,
  privacyCollectionShape,
} from "./privacy-read-definitions";
import {
  prepareD1PrivacyScope,
  checkD1PrivacyScope,
  type D1PrivacySubjectScope,
} from "./privacy-scope";
type ReadRequest = Exclude<z.infer<typeof privacyRequest>, { action: "erase" }>;
const changed = () =>
  new ApiError(409, "CONFLICT", "Data changed. Restart the export.");
function base64(raw: unknown): string {
  const bytes =
    raw instanceof Uint8Array
      ? raw
      : raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : Array.isArray(raw)
          ? Uint8Array.from(raw as number[])
          : null;
  if (!bytes) throw new Error("Invalid privacy checkpoint encoding");
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(chunks.join(""));
}
function binaryData(
  row: Record<string, unknown>,
  kind: "checkpoint" | "write",
) {
  return JSON.stringify(
    kind === "checkpoint"
      ? {
          conversationId: row.conversationId,
          namespace: row.namespace,
          checkpointId: row.checkpoint_id,
          parentCheckpointId: row.parent_id,
          type: row.checkpoint_type,
          encoding: "base64",
          data: base64(row.checkpoint),
          metadataType: row.metadata_type,
          metadata: base64(row.metadata),
        }
      : {
          conversationId: row.conversationId,
          namespace: row.namespace,
          checkpointId: row.checkpoint_id,
          taskId: row.task_id,
          taskPath: row.task_path,
          index: row.idx,
          channel: row.channel,
          type: row.value_type,
          encoding: "base64",
          data: base64(row.value),
        },
  );
}
export function createD1PrivacyReader(database: D1Database) {
  async function stable<T>(
    installation: PrivacyInstallation,
    subjects: PrivacySubject[],
    contexts: string[] | null,
    build: (scope: (s: PrivacySubject) => D1PrivacySubjectScope) => D1Query[],
    finish: (rows: D1Result<Record<string, unknown>>[]) => T | Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const scope = await prepareD1PrivacyScope(
        database,
        installation,
        subjects,
        contexts,
      );
      const result = await runD1Batch<Record<string, unknown>>(database, [
        scope.check(),
        ...build(scope.forSubject),
      ]);
      if (!checkD1PrivacyScope(result[0].results[0])) continue;
      return finish(result.slice(1));
    }
    throw changed();
  }
  function contexts(scope: D1PrivacySubjectScope, after: string) {
    const { db } = scope,
      defs = privacyReadQueries(scope);
    // Bound each collection before combining via JSON, avoiding D1's compound
    // SELECT limit while retaining the first 101 distinct global contexts.
    const groups = privacyContextCollections.map((name) => {
      const q = defs[name].query;
      const page = db
        .selectDistinct({ context: q.context })
        .from(q)
        .where(sql`${q.context} COLLATE BINARY>${after}`)
        .orderBy(sql`${q.context} COLLATE BINARY`)
        .limit(PRIVACY_CONTEXT_PAGE_SIZE + 1)
        .as("context_page");
      return db
        .select({ value: sql`json_group_array(${page.context})` })
        .from(page);
    });
    return scope.wrap(
      db
        .selectDistinct({ context: sql<string>`item.value`.as("context") })
        .from(
          sql`json_each(json_array(${sql.join(
            groups.map((group) => sql`json(${group})`),
            sql`,`,
          )})) groups`,
        )
        .innerJoin(sql`json_each(groups.value) item`, sql`true`)
        .orderBy(sql`item.value COLLATE BINARY`)
        .limit(PRIVACY_CONTEXT_PAGE_SIZE + 1),
    );
  }
  return {
    async execute(
      installation: PrivacyInstallation,
      input: ReadRequest,
    ): Promise<unknown> {
      const parsed = privacyRequest.safeParse(input);
      if (!parsed.success || parsed.data.action === "erase")
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Invalid privacy read request.",
        );
      input = parsed.data;
      if (input.action === "catalog") {
        const subject = await privacySubject(installation, ""),
          after = input.after ?? "";
        return stable(
          installation,
          [subject],
          null,
          (get) => {
            const scope = get(subject),
              { db, p } = scope;
            const combined = union(
              db
                .select({
                  context: sql<string>`${lmsCourses.contextId}`.as("context"),
                })
                .from(p)
                .innerJoin(
                  lmsCourses,
                  eq(lmsCourses.installationId, p.installation),
                ),
              db
                .select({
                  context: sql<string>`${teachingConnections.contextId}`.as(
                    "context",
                  ),
                })
                .from(p)
                .innerJoin(
                  teachingConnections,
                  and(
                    eq(teachingConnections.provider, sql`'moodle'`),
                    eq(teachingConnections.installationId, p.installation),
                  ),
                ),
              db
                .select({
                  context:
                    sql<string>`json_extract(${ltiCredentials.payload},'$.contextId')`.as(
                      "context",
                    ),
                })
                .from(p)
                .innerJoin(
                  ltiCredentials,
                  and(
                    eq(ltiCredentials.kind, sql`'lti-history'`),
                    eq(
                      sql`json_extract(${ltiCredentials.payload},'$.registrationId')`,
                      p.registration,
                    ),
                  ),
                )
                .where(
                  isNotNull(
                    sql`json_extract(${ltiCredentials.payload},'$.contextId')`,
                  ),
                ),
              db
                .select({ context: sql<string>`'@orphan'`.as("context") })
                .from(p),
            ).as("contexts");
            return [
              scope.wrap(
                db
                  .select({ context: sql`${combined.context}`.as("context") })
                  .from(combined)
                  .where(sql`${combined.context} COLLATE BINARY>${after}`)
                  .orderBy(sql`${combined.context} COLLATE BINARY`)
                  .limit(PRIVACY_CONTEXT_PAGE_SIZE + 1),
              ),
            ];
          },
          (rows) =>
            privacyCatalogPage(rows[0].results, (row) => row.context as string),
        );
      }
      if (input.action === "users") {
        const requested = input.subjects,
          subjects = await Promise.all(
            requested.map((s) => privacySubject(installation, s)),
          );
        return stable(
          installation,
          subjects,
          input.contexts,
          (get) => subjects.map((s) => contexts(get(s), "")),
          (rows) => ({
            subjects: privacySubjectsWithData(
              requested,
              rows.map((row) => row.results.length > 0),
            ),
          }),
        );
      }
      const subject = await privacySubject(installation, input.subject);
      if (input.action === "contexts") {
        const after = input.after ?? "";
        return stable(
          installation,
          [subject],
          null,
          (get) => [contexts(get(subject), after)],
          (rows) =>
            privacyContextPage(rows[0].results, (row) => row.context as string),
        );
      }
      const request = input,
        point = request.cursor?.record,
        rawId = privacyRecordCursor(request.cursor),
        shape = privacyCollectionShape(request.collection);
      const failure = privacyCursorFailure(
        request.collection,
        shape.cast === "bigint"
          ? "integer"
          : shape.cast === "uuid"
            ? "uuid"
            : "opaque",
        rawId,
        (value) => z.uuid().safeParse(value).success,
      );
      if (failure === "retiredConversation") throw changed();
      if (failure === "invalid")
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid export cursor.");
      const id = shape.cast === "uuid" ? rawId?.toLowerCase() : rawId;
      return stable(
        installation,
        [subject],
        request.contexts,
        (get) => {
          const scope = get(subject),
            d = privacyReadQueries(scope)[request.collection],
            q = d.query;
          const binary = Object.fromEntries(
            binaryNames.map((name) => [name, sql`${q[name]}`.as(name)]),
          );
          return [
            scope.wrap(
              scope.db
                .select({
                  id: sql<string>`CAST(${q.key} AS TEXT)`.as("id"),
                  context: sql`${q.context}`.as("context"),
                  data: sql`${q.data}`.as("data"),
                  ...binary,
                })
                .from(q)
                .where(
                  id
                    ? point
                      ? eq(sql`${q.key}`, id)
                      : gt(sql`${q.key}`, id)
                    : undefined,
                )
                .orderBy(sql`${q.key}`)
                .limit(1),
            ),
          ];
        },
        async (rows) => {
          const row = rows[0].results[0];
          if (!row) {
            const result = privacyExportPage(null, point);
            if ("changed" in result) throw changed();
            return result;
          }
          const data = shape.binary ? binaryData(row, shape.binary) : row.data;
          if (typeof data !== "string")
            throw new Error("Invalid privacy export data");
          const characters = Array.from(data),
            revision = await digest(data),
            offset = point?.offset ?? 0;
          const result = privacyExportPage(
            {
              id: row.id as string,
              context: row.context as string,
              total: characters.length,
              revision,
              chunk: characters
                .slice(offset, offset + PRIVACY_EXPORT_CHUNK_CHARACTERS)
                .join(""),
            },
            point,
          );
          if ("changed" in result) throw changed();
          return result;
        },
      );
    },
  };
}
