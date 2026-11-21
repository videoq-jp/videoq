import { sql, type SQLWrapper } from "drizzle-orm";

/** Both dialects support MATERIALIZED but Drizzle's CTE API has no modifier.
 * Keep the unsupported keyword here; relations and mutations stay typed. */
export function materializedCtesSQL(
  ctes: readonly { name: string; source: SQLWrapper }[],
  statement: SQLWrapper,
) {
  return sql`WITH ${sql.join(
    ctes.map(
      ({ name, source }) =>
        sql`${sql.identifier(name)} AS MATERIALIZED(${source.getSQL()})`,
    ),
    sql`, `,
  )} ${statement.getSQL()}`;
}
