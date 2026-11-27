import { getTableColumns, getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type pg from 'pg';
/** Minimal fixtures promise parity only for explicitly selected columns.
 * Atomic workflow tests may omit other columns/tables; use the generated-schema
 * suite for production constraints, not a green minimal fixture as proof. */
export async function assertPostgresColumnContract(pool: pg.Pool, table: PgTable, properties: readonly string[]): Promise<void> {
  const columns = getTableColumns(table);
  for (const property of properties) {
    const column = columns[property];
    if (!column) throw new Error(`Unknown schema column ${property}`);
    const { rows } = await pool.query<{type:string;not_null:boolean}>(`SELECT format_type(atttypid,atttypmod) AS type,attnotnull AS not_null FROM pg_attribute WHERE attrelid=$1::regclass AND attname=$2 AND NOT attisdropped`,[getTableName(table),column.name]);
    const actual = rows[0];
    const normalize = (type: string) => type.replace('character varying','varchar');
    if (!actual || normalize(actual.type) !== normalize(column.getSQLType()) || actual.not_null !== column.notNull) {
      throw new Error(`Fixture constraint drift: ${getTableName(table)}.${column.name}; expected ${column.getSQLType()} notNull=${column.notNull}, got ${JSON.stringify(actual)}`);
    }
  }
}
