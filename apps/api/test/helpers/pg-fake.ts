/**
 * Fake pg.Client helpers for Vitest.
 * Drizzle passes QueryConfig `{ text, values, rowMode: "array" }` (not a bare SQL string).
 */

export type PgQueryInput =
  | string
  | { text?: string; values?: unknown[]; name?: string; rowMode?: string };

/** Case-insensitive, quote-stripped `includes` for matcher-friendly SQL. */
export type MatchableSql = string & {
  includes(search: string): boolean;
};

export function normalizePgQuery(
  sqlOrConfig: PgQueryInput,
  args: unknown[] = [],
): { sql: string; args: unknown[]; rowMode?: string } {
  if (typeof sqlOrConfig === "string") {
    return { sql: sqlOrConfig, args };
  }
  return {
    sql: String(sqlOrConfig?.text ?? ""),
    args: Array.isArray(sqlOrConfig?.values) ? sqlOrConfig.values : args,
    rowMode: sqlOrConfig?.rowMode,
  };
}

export function matchableSql(sql: string): MatchableSql {
  const stripped = sql.replace(/"/g, "");
  const upper = stripped.toUpperCase();
  return Object.assign<MatchableSql>(new String(stripped) as unknown as string, {
    includes(search: string) {
      return upper.includes(String(search).replace(/"/g, "").toUpperCase());
    },
    toString() {
      return stripped;
    },
    valueOf() {
      return stripped;
    },
  });
}

export type QueryCall = { sql: MatchableSql; args: unknown[] };

function toPgRows(
  rawRows: Record<string, unknown>[] | unknown[][],
  rowMode?: string,
): unknown[] {
  if (rowMode !== "array") return rawRows;
  return rawRows.map((r) => (Array.isArray(r) ? r : Object.values(r)));
}

/**
 * Shared FakeClient.query implementation. Call from inside `vi.mock("pg")` factories.
 */
export function executeFakePgQuery(opts: {
  calls?: QueryCall[];
  sqlOrConfig: PgQueryInput;
  args?: unknown[];
  rowsFor: (sql: MatchableSql, args: unknown[]) => Record<string, unknown>[] | unknown[][];
  rowCountFor?: (
    sql: MatchableSql,
    args: unknown[],
    rows: Record<string, unknown>[],
  ) => number;
}) {
  const { sql, args: a, rowMode } = normalizePgQuery(opts.sqlOrConfig, opts.args ?? []);
  const matchSql = matchableSql(sql);
  opts.calls?.push({ sql: matchSql, args: a });
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) {
    return { rows: [], rowCount: 0 };
  }
  const rawRows = opts.rowsFor(matchSql, a);
  const objectRows = rawRows.every(Array.isArray)
    ? []
    : (rawRows);
  const rows = toPgRows(rawRows, rowMode);
  const rowCount = opts.rowCountFor
    ? opts.rowCountFor(matchSql, a, objectRows)
    : rows.length;
  return { rows, rowCount };
}
