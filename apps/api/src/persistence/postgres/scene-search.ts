import type { SceneHit, SceneSearchRepository } from "../contracts/scene-search";
import { PGEngine, PGVectorStore } from "@yukiharada1228/langchain-postgres";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import pg from "pg";
import { databaseConnectionString } from "../../db/pool";
import { embedQuery } from "../../lib/embeddings";
import { embeddingDimensions, embeddingTable, resolveEmbeddingConfig } from "../../lib/embedding-contract";
import { assertEmbeddingSchema } from "../../lib/embedding-schema";
import type { Bindings } from "../../types/bindings";
import type { AnswerCostLedger } from "../../lib/answer-cost-ledger";
import { importReadSnapshot, validateReadSnapshot } from "./read-snapshot";

const ALLOWED_TABLES = new Set(["scene_embeddings", "scene_embeddings_768"]);

function resolveVectorTable(env: Bindings): string {
  const expected = embeddingTable(resolveEmbeddingConfig(env));
  const name = env.PGVECTOR_COLLECTION_NAME || expected;
  if (!ALLOWED_TABLES.has(name)) {
    throw new Error(`vector table '${name}' is not in the allowed list`);
  }
  if (name !== expected) throw new Error("Vector table does not match the selected embedding profile.");
  return name; // allowlist 済みなので式内展開は安全
}

const RETRIEVER_K = 20;

/**
 * 検索クエリの埋め込みは hosted / private の OpenAI 互換 API を使う
 * lib/embeddings.ts に一本化する。インデックス作成は worker 側の責務なので、
 * embedDocuments は API からは呼ばれない。
 */
function sceneEmbeddings(env: Bindings, signal?: AbortSignal, costLedger?: AnswerCostLedger): EmbeddingsInterface {
  return {
    embedQuery: (text: string) => embedQuery(env, text, signal, costLedger),
    embedDocuments: (texts: string[]) =>
      Promise.all(texts.map((text) => embedQuery(env, text, signal, costLedger))),
  };
}

function parseMetadataColumn(rows: Array<Record<string, unknown>>): void {
  for (const row of rows) {
    const raw = row.langchain_metadata;
    if (typeof raw === "string") {
      try {
        row.langchain_metadata = JSON.parse(raw);
      } catch {
        row.langchain_metadata = {};
      }
    }
  }
}

/**
 * pg は json 列を既定で自動パースするが、Hyperdrive 経由の Workers 環境では
 * 文字列のまま返ることがある。
 * ライブラリの rowToDocument は metadata オブジェクトへ直接プロパティ代入するため、
 * 文字列のままだと TypeError で落ちる。ここでクエリ結果を正規化してから渡す。
 */
function withMetadataParsing(pool: pg.Pool): pg.Pool {
  const rawQuery = pool.query.bind(pool) as (...args: unknown[]) => Promise<pg.QueryResult<Record<string, unknown>>> | void;
  const rawConnect = pool.connect.bind(pool) as (...args: unknown[]) => Promise<pg.PoolClient> | void;
  const wrappedClients = new WeakSet<pg.PoolClient>();

  (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
    // pg 内部は callback 形式も使う。戻り値が Promise の呼び出しだけを加工する。
    return rawQuery(...args)?.then((result) => {
      parseMetadataColumn(result.rows);
      return result;
    });
  };

  (pool as unknown as { connect: unknown }).connect = (...args: unknown[]) => {
    return rawConnect(...args)?.then((client) => {
      if (!wrappedClients.has(client)) {
        wrappedClients.add(client);
        const rawClientQuery = client.query.bind(client) as (...args: unknown[]) => Promise<pg.QueryResult<Record<string, unknown>>> | void;
        (client as unknown as { query: unknown }).query = (...queryArgs: unknown[]) => {
          return rawClientQuery(...queryArgs)?.then((result) => {
            parseMetadataColumn(result.rows);
            return result;
          });
        };
      }
      return client;
    });
  };

  return pool;
}

const text = (v: unknown) => (typeof v === "string" ? v : (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") ? String(v) : "");

/**
 * リクエストスコープのシーン検索ハンドル。
 * ReAct は 1 リクエスト内で複数回検索するため、engine / store は開きっぱなしにして
 * 使い回し、呼び出し側が finally で close する。
 */
export type SceneSearch = {
  /** open 時のスコープ内に限り、動画をさらに絞り込める。 */
  search(query: string, videoIds?: readonly number[]): Promise<SceneHit[]>;
  close(): Promise<void>;
};

/** Precomputed-vector contract used by both runtime and migration evaluation. */
export function createPostgresSceneSearchRepository(
  store: Pick<PGVectorStore, "similaritySearchVectorWithScore">,
  dimensions: 768 | 1536,
): SceneSearchRepository {
  return {
    async search({ queryEmbedding, userId, videoIds, limit }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Search limit must be between 1 and 50");
      if (queryEmbedding.length !== dimensions ||
          !queryEmbedding.every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value))) ||
          !queryEmbedding.some(value => Math.fround(value) !== 0)) throw new Error("Invalid query embedding");
      if (videoIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error("Invalid video ID");
      const selected = [...new Set(videoIds)];
      if (!selected.length) return [];
      const hits = await store.similaritySearchVectorWithScore(queryEmbedding, limit, {
        user_id: userId, video_id: { $in: selected },
      });
      return hits.map(([doc]) => ({
        content: doc.pageContent ?? "",
        videoId: Number(doc.metadata?.video_id),
        videoTitle: text(doc.metadata?.video_title),
        startTime: text(doc.metadata?.start_time),
        endTime: text(doc.metadata?.end_time),
      }));
    },
  };
}

/** Caller owns this request-scoped connection and must close it in finally. */
export async function openPostgresEmbeddingSceneSearch(
  env: Bindings,
  signal?: AbortSignal,
  costLedger?: AnswerCostLedger,
  options: { snapshot?: string } = {},
): Promise<SceneSearchRepository & { close(): Promise<void> }> {
  signal?.throwIfAborted();
  if (options.snapshot !== undefined) validateReadSnapshot(options.snapshot);
  const table = resolveVectorTable(env);
  const config = resolveEmbeddingConfig(env);
  const pool = withMetadataParsing(new pg.Pool({
    connectionString: databaseConnectionString(env), connectionTimeoutMillis: 10_000, max: 1,
    ...(options.snapshot !== undefined ? { idleTimeoutMillis: 0 } : {}),
  }));
  let snapshotUnavailable = false, snapshotConnections = 0;
  pool.on("error", () => { if (options.snapshot !== undefined) snapshotUnavailable = true; });
  pool.on("connect", () => {
    if (options.snapshot !== undefined && ++snapshotConnections > 1) snapshotUnavailable = true;
  });
  const assertSnapshot = () => {
    if (snapshotUnavailable) throw new Error("PostgreSQL read snapshot is unavailable; restart the complete evaluation.");
  };
  const engine = PGEngine.fromPool(pool);
  const close = async () => {
    try { if (options.snapshot !== undefined && !snapshotUnavailable) await pool.query("ROLLBACK"); }
    finally { await engine.close(); }
  };
  try {
    if (options.snapshot !== undefined) await importReadSnapshot(pool, options.snapshot);
    if (options.snapshot !== undefined) await pool.query("SET LOCAL idle_in_transaction_session_timeout='20min'");
    await assertEmbeddingSchema(pool, config);
    signal?.throwIfAborted();
    assertSnapshot();
    const store = await PGVectorStore.initialize(engine, sceneEmbeddings(env, signal, costLedger), table, {
      metadataColumns: ["user_id", "video_id"],
    });
    signal?.throwIfAborted();
    assertSnapshot();
    const repository = createPostgresSceneSearchRepository(store, embeddingDimensions(config) as 768 | 1536);
    return {
      async search(params) {
        signal?.throwIfAborted();
        assertSnapshot();
        const hits = await repository.search(params);
        signal?.throwIfAborted();
        assertSnapshot();
        return hits;
      },
      close,
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

export async function openPostgresSceneSearch(
  env: Bindings,
  params: { userId: string; videoIds: readonly number[] },
  signal?: AbortSignal,
  costLedger?: AnswerCostLedger,
): Promise<SceneSearch> {
  const repository = await openPostgresEmbeddingSceneSearch(env, signal, costLedger);
  const allowedVideoIds = new Set(params.videoIds);
  return {
    async search(query: string, videoIds?: readonly number[]): Promise<SceneHit[]> {
      signal?.throwIfAborted();
      if (videoIds !== undefined && (
        videoIds.length === 0 || videoIds.some((id) => !allowedVideoIds.has(id))
      )) throw new Error("Video selection must be a non-empty subset of the current course.");
      const selected = videoIds === undefined ? [...allowedVideoIds] : [...new Set(videoIds)];
      if (!selected.length) return [];
      const queryEmbedding = await embedQuery(env, query, signal, costLedger);
      return repository.search({queryEmbedding, userId: params.userId, videoIds: selected, limit: RETRIEVER_K});
    },
    close: () => repository.close(),
  };
}
