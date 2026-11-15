import {sql} from 'drizzle-orm';
import {sqliteTable,text,integer} from 'drizzle-orm/sqlite-core';
/** Offline staging imports only. common_imported never means cutover-ready. */
export const migrationImports=sqliteTable('migration_imports',{
 id:text('id').primaryKey(),archiveSha256:text('archive_sha256').notNull(),mappingSha256:text('mapping_sha256').notNull(),
 status:text('status').notNull(),tableIndex:integer('table_index').notNull().default(0),rowIndex:integer('row_index').notNull().default(0),
 importedRows:integer('imported_rows').notNull().default(0),
 startedAt:text('started_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
 updatedAt:text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});
