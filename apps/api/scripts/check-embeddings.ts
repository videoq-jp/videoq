/** Read-only diagnosis. Model calls require the explicit --probe flag. */
import "dotenv/config";
import pg from "pg";
import { assertEmbeddingSchema } from "../src/lib/embedding-schema";
import { embeddingDimensions, embeddingDiagnostic, resolveEmbeddingConfig } from "../src/lib/embedding-contract";
import { embedQuery } from "../src/lib/embeddings";

const config = resolveEmbeddingConfig(process.env);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for embedding diagnosis.");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  await assertEmbeddingSchema(client, config);
  if (process.argv.includes("--probe")) {
    const vector = await embedQuery(process.env, "VideoQ embedding preflight");
    console.info(JSON.stringify(embeddingDiagnostic(config, { db_dimensions: embeddingDimensions(config), actual_dimensions: vector.length })));
  }
} finally {
  await client.end();
}
