import type pg from 'pg';
import type { Bindings } from '../types/bindings';
import { applicationTrafficPaused } from '../lib/migration-traffic';
import { embeddingFingerprint, embeddingTable, resolveEmbeddingConfig, EmbeddingCompatibilityError, EmbeddingConfigurationError, requiresEmbeddingDeploymentIdentity } from '../lib/embedding-contract';

/** Lifecycle-only check: never scan provenance on the frequent /ready probe. */
export async function assertPostgresEmbeddingAdmission(
  pool: Pick<pg.Pool, 'query'>, env: Bindings, options: { resume?: boolean; schema?: string } = {},
): Promise<{ serving: boolean; fingerprint: string }> {
  const config = resolveEmbeddingConfig(env);
  const fingerprint = await embeddingFingerprint(config);
  if (applicationTrafficPaused(env) && !options.resume) return { serving: false, fingerprint };
  if (requiresEmbeddingDeploymentIdentity(config, env) && (!config.revision || !config.preprocessing || config.revision === 'provider-managed')) {
    throw new EmbeddingConfigurationError('EMBEDDING_CONFIG_INVALID', 'Operator-controlled embedding admission requires explicit immutable revision and preprocessing identity.', config);
  }
  const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
  const table = `${quote(options.schema ?? 'public')}.${quote(embeddingTable(config))}`;
  const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE (langchain_metadata->>'embedding_fingerprint') IS DISTINCT FROM $1 LIMIT 1`, [fingerprint]);
  if (rows.length) throw new EmbeddingCompatibilityError();
  return { serving: true, fingerprint };
}
