import {
  embeddingDimensions,
  embeddingTable,
  EmbeddingConfigurationError,
  embeddingDiagnostic,
  type EmbeddingConfig,
} from "./embedding-contract";

const EMBEDDING_SCHEMA_SQL = `
  SELECT t.typname AS type_name, a.atttypmod AS dimensions
    FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
   WHERE a.attrelid = to_regclass($1) AND a.attname = 'embedding'
     AND a.attnum > 0 AND NOT a.attisdropped
`;

type SchemaConnection = {
  query(text: string, values: string[]): Promise<{ rows: { type_name?: unknown; dimensions?: unknown }[] }>;
};

export async function assertEmbeddingSchema(client: SchemaConnection, config: EmbeddingConfig): Promise<void> {
  const { rows } = await client.query(EMBEDDING_SCHEMA_SQL, [`public.${embeddingTable(config)}`]);
  const row = rows[0];
  const dimensions = typeof row?.dimensions === "number" ? row.dimensions : null;
  if (row?.type_name !== "vector" || dimensions !== embeddingDimensions(config)) {
    throw new EmbeddingConfigurationError(
      "EMBEDDING_SCHEMA_MISMATCH",
      `Embedding storage must use vector(${embeddingDimensions(config)}). Ask an administrator to check the database schema.`,
      config,
      dimensions,
    );
  }
  console.info(JSON.stringify(embeddingDiagnostic(config, { db_dimensions: dimensions })));
}
