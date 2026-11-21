import { materializedCtesSQL } from "../materialized-cte";
import { getTableColumns, sql, is, SQL, type SQLWrapper } from "drizzle-orm";
import {
  SQLiteSyncDialect,
  type AnySQLiteColumn,
  type SQLiteTable,
  type SQLiteInsertValue,
} from "drizzle-orm/sqlite-core";

export type D1Query = { toSQL(): { sql: string; params: unknown[] } };
export type D1Connection = ReturnType<
  typeof import("./connection").createD1Connection
>;

type InsertProjection<T extends SQLiteTable> = {
  [K in keyof T["$inferInsert"]]: AnySQLiteColumn | SQL;
};

/** SQLite INSERT SELECT requires the whole table projection. Keep omitted
 * columns tied to schema defaults instead of copying defaults into repositories.
 * Required insert fields remain required in the supplied projection. */
export function insertSelectFields<T extends SQLiteTable>(
  table: T,
  fields: InsertProjection<T>,
): {
  [K in keyof T["$inferInsert"]]-?: SQL.Aliased;
} {
  const supplied: Record<string, AnySQLiteColumn | SQL | undefined> = fields;
  return Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([key, column]) => {
      const value = supplied[key];
      if (value !== undefined) return [key, sql`${value}`.as(key)];
      const fallback: unknown = column.default ?? column.defaultFn?.();
      return [
        key,
        (fallback === undefined
          ? sql`NULL`
          : sql`${is(fallback, SQL) ? fallback : sql.param(fallback, column)}`
        ).as(key),
      ];
    }),
  ) as { [K in keyof T["$inferInsert"]]-?: SQL.Aliased };
}

export function prepareD1Query(
  database: D1Database,
  statement: D1Query,
): D1PreparedStatement {
  const query = statement.toSQL();
  return database.prepare(query.sql).bind(...query.params);
}

/** Compilation only: no query is executed until D1 runs the entire batch. */
export function runD1Batch<T = Record<string, unknown>>(
  database: D1Database,
  statements: (D1Query | D1PreparedStatement)[],
) {
  return database.batch<T>(
    statements.map((statement) =>
      "toSQL" in statement ? prepareD1Query(database, statement) : statement,
    ),
  );
}

/** Drizzle has no SQLite MATERIALIZED option. Only the CTE modifier is custom;
 * its SELECT and the mutation still come from typed builders. This also freezes
 * self-referential deletion targets before any row can disappear. */
export function withMaterialized(
  name: string,
  source: SQLWrapper,
  mutation: SQLWrapper,
): D1Query {
  return withMaterializedCtes([{ name, source }], mutation);
}
export function withMaterializedCtes(
  ctes: readonly { name: string; source: SQLWrapper }[],
  mutation: SQLWrapper,
): D1Query {
  return {
    toSQL: () =>
      new SQLiteSyncDialect().sqlToQuery(materializedCtesSQL(ctes, mutation)),
  };
}

/** Conditional INSERTs can reuse ordinary typed .values() data as a SELECT. */
export function insertSelectValues<T extends SQLiteTable>(
  table: T,
  values: SQLiteInsertValue<T>,
) {
  const columns = getTableColumns(table);
  const fields = Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        key,
        is(value, SQL) ? value : sql`${sql.param(value, columns[key])}`,
      ]),
  );
  return insertSelectFields(table, fields as InsertProjection<T>);
}
