import { getTableColumns, getTableName, is, SQL, sql } from "drizzle-orm";
import {
  getTableConfig,
  type PgTable,
  type PgInsertValue,
} from "drizzle-orm/pg-core";

/** INSERT SELECT cannot use DEFAULT. Derive its complete projection from the
 * schema, including identity sequences, instead of repeating defaults in CRUD. */
export function insertSelectValues<T extends PgTable>(
  table: T,
  values: PgInsertValue<T>,
) {
  const supplied: Record<string, unknown> = values;
  const schema = getTableConfig(table).schema;
  const relation = schema
    ? `"${schema.replaceAll('"', '""')}"."${getTableName(table).replaceAll('"', '""')}"`
    : `"${getTableName(table).replaceAll('"', '""')}"`;
  return Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([key, column]) => {
      const value = supplied[key];
      if (value !== undefined)
        return [
          key,
          (is(value, SQL) ? value : sql`${sql.param(value, column)}`).as(key),
        ];
      if (column.generatedIdentity || /serial/i.test(column.getSQLType())) {
        return [
          key,
          sql`nextval(pg_get_serial_sequence(${relation},${column.name}))`.as(
            key,
          ),
        ];
      }
      const fallback: unknown =
        column.default ?? column.defaultFn?.() ?? column.onUpdateFn?.();
      return [
        key,
        (fallback === undefined
          ? sql`NULL`
          : is(fallback, SQL)
            ? fallback
            : sql`${sql.param(fallback, column)}`
        ).as(key),
      ];
    }),
  ) as { [K in keyof T["$inferInsert"]]-?: SQL.Aliased };
}
