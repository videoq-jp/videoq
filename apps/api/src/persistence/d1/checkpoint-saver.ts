import { and, eq, lt, desc, exists, sql } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import {
  insertSelectFields,
  runD1Batch,
  type D1Query,
} from "../../db/d1/query-builders";
import {
  chatConversations,
  conversationCheckpoints as checkpoints,
  conversationCheckpointWrites as checkpointWrites,
  mutationReceipts as receipts,
} from "../../db/schema/sqlite";
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  TASKS,
  compareWritesSortKeys,
  writesSortKey,
  getCheckpointId,
  maxChannelVersion,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
  type CheckpointListOptions,
  type ChannelVersions,
  type PendingWrite,
  type CheckpointPendingWrite,
  type SerializerProtocol,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";

import { D1_CHECKPOINT_MAX_BYTES as MAX_BYTES } from "./checkpoint-limits";
type Binary = number[] | ArrayBuffer | Uint8Array;
type Stored = {
  checkpoint_id: string;
  parent_id: string | null;
  checkpoint_type: string;
  checkpoint: Binary;
  metadata_type: string;
  metadata: Binary;
};

const bytes = (value: Binary) =>
  value instanceof Uint8Array
    ? value
    : new Uint8Array(
        value instanceof ArrayBuffer ? value : Uint8Array.from(value),
      );
const buffer = (value: Uint8Array) => Uint8Array.from(value).buffer;
export class D1CheckpointAccessError extends Error {
  constructor() {
    super("Conversation checkpoint lease is unavailable");
  }
}
/** Request-scoped LangGraph saver. Every SQL operation is fenced to one live lease. */
export class D1CheckpointSaver extends BaseCheckpointSaver {
  constructor(
    private database: D1Database,
    private scope: { threadId: string; leaseId: string },
    serializer?: SerializerProtocol,
  ) {
    super(serializer);
    if (!scope.threadId || !scope.leaseId)
      throw new Error("Missing checkpoint scope");
  }
  private get db() {
    return createD1Connection(this.database);
  }
  private accessPredicate() {
    return exists(
      this.db
        .select({ id: chatConversations.threadId })
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.threadId, this.scope.threadId),
            eq(chatConversations.leaseId, this.scope.leaseId),
            sql`julianday(${chatConversations.leasedUntil})>julianday('now')`,
            sql`julianday(${chatConversations.expiresAt})>julianday('now')`,
          ),
        ),
    );
  }
  private receipt(token: string) {
    return exists(
      this.db
        .select({ token: receipts.token })
        .from(receipts)
        .where(eq(receipts.token, token)),
    );
  }
  private projection() {
    return {
      checkpoint_id: checkpoints.checkpointId,
      parent_id: checkpoints.parentId,
      checkpoint_type: checkpoints.checkpointType,
      checkpoint: sql<Binary>`${checkpoints.checkpoint}`,
      metadata_type: checkpoints.metadataType,
      metadata: sql<Binary>`${checkpoints.metadata}`,
    };
  }
  private identity(config: RunnableConfig) {
    const thread: unknown = config.configurable?.thread_id;
    if (thread !== this.scope.threadId) throw new D1CheckpointAccessError();
    const namespace: unknown = config.configurable?.checkpoint_ns ?? "";
    const id: unknown = getCheckpointId(config);
    if (typeof namespace !== "string" || typeof id !== "string")
      throw new Error("Invalid checkpoint identity");
    return { namespace, id };
  }
  private async access() {
    return Boolean(
      await this.db
        .select({ id: chatConversations.threadId })
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.threadId, this.scope.threadId),
            this.accessPredicate(),
          ),
        )
        .get(),
    );
  }
  private async writes(
    namespace: string,
    id: string,
  ): Promise<CheckpointPendingWrite[]> {
    const rows = await this.db
      .select({
        task_id: checkpointWrites.taskId,
        idx: checkpointWrites.index,
        task_path: checkpointWrites.taskPath,
        channel: checkpointWrites.channel,
        value_type: checkpointWrites.valueType,
        value: sql<Binary>`${checkpointWrites.value}`,
      })
      .from(checkpointWrites)
      .where(
        and(
          eq(checkpointWrites.threadId, this.scope.threadId),
          eq(checkpointWrites.namespace, namespace),
          eq(checkpointWrites.checkpointId, id),
          this.accessPredicate(),
        ),
      );
    rows.sort((a, b) =>
      compareWritesSortKeys(
        writesSortKey(a.task_path, a.task_id, a.idx),
        writesSortKey(b.task_path, b.task_id, b.idx),
      ),
    );
    return Promise.all(
      rows.map(
        async (row) =>
          [
            row.task_id,
            row.channel,
            await this.serde.loadsTyped(row.value_type, bytes(row.value)),
          ] as CheckpointPendingWrite,
      ),
    );
  }
  private async tuple(
    namespace: string,
    row: Stored,
  ): Promise<CheckpointTuple> {
    const checkpoint = (await this.serde.loadsTyped(
      row.checkpoint_type,
      bytes(row.checkpoint),
    )) as Checkpoint;
    if (checkpoint.v < 4 && row.parent_id) {
      checkpoint.channel_values[TASKS] = (
        await this.writes(namespace, row.parent_id)
      )
        .filter(([, channel]) => channel === TASKS)
        .map(([, , value]) => value);
      const versions = Object.values(checkpoint.channel_versions);
      checkpoint.channel_versions[TASKS] = versions.length
        ? maxChannelVersion(...versions)
        : this.getNextVersion(undefined);
    }
    return {
      config: {
        configurable: {
          thread_id: this.scope.threadId,
          checkpoint_ns: namespace,
          checkpoint_id: row.checkpoint_id,
        },
      },
      checkpoint,
      metadata: (await this.serde.loadsTyped(
        row.metadata_type,
        bytes(row.metadata),
      )) as CheckpointMetadata,
      ...(row.parent_id
        ? {
            parentConfig: {
              configurable: {
                thread_id: this.scope.threadId,
                checkpoint_ns: namespace,
                checkpoint_id: row.parent_id,
              },
            },
          }
        : {}),
      pendingWrites: await this.writes(namespace, row.checkpoint_id),
    };
  }
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { namespace, id } = this.identity(config);
    const row = await this.db
      .select(this.projection())
      .from(checkpoints)
      .where(
        and(
          eq(checkpoints.threadId, this.scope.threadId),
          eq(checkpoints.namespace, namespace),
          id ? eq(checkpoints.checkpointId, id) : undefined,
          this.accessPredicate(),
        ),
      )
      .orderBy(desc(checkpoints.checkpointId))
      .limit(1)
      .get();
    if (!row) {
      if (!(await this.access())) throw new D1CheckpointAccessError();
      return undefined;
    }
    return this.tuple(namespace, row);
  }
  async *list(
    config: RunnableConfig,
    options: CheckpointListOptions = {},
  ): AsyncGenerator<CheckpointTuple> {
    const { namespace, id } = this.identity(config);
    const cursor: unknown = options.before
      ? getCheckpointId(options.before)
      : "";
    if (typeof cursor !== "string")
      throw new Error("Invalid checkpoint cursor");
    let before = cursor;
    if (
      options.limit !== undefined &&
      (!Number.isSafeInteger(options.limit) || options.limit < 0)
    )
      throw new Error("Invalid checkpoint list limit");
    let remaining = options.limit ?? Infinity;
    while (remaining > 0) {
      const rows = await this.db
        .select(this.projection())
        .from(checkpoints)
        .where(
          and(
            eq(checkpoints.threadId, this.scope.threadId),
            eq(checkpoints.namespace, namespace),
            id ? eq(checkpoints.checkpointId, id) : undefined,
            before ? lt(checkpoints.checkpointId, before) : undefined,
            this.accessPredicate(),
          ),
        )
        .orderBy(desc(checkpoints.checkpointId))
        .limit(20);
      if (!rows.length) {
        if (!(await this.access())) throw new D1CheckpointAccessError();
        return;
      }
      for (const row of rows) {
        before = row.checkpoint_id;
        const tuple = await this.tuple(namespace, row);
        if (
          options.filter &&
          !Object.entries(options.filter).every(
            ([key, value]) =>
              (tuple.metadata as Record<string, unknown>)[key] === value,
          )
        )
          continue;
        yield tuple;
        if (--remaining <= 0) return;
      }
      if (rows.length < 20) return;
    }
  }
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const { namespace, id } = this.identity(config);
    if (!checkpoint.id) throw new Error("Missing checkpoint id");
    const [[checkpointType, checkpointBytes], [metadataType, metadataBytes]] =
      await Promise.all([
        this.serde.dumpsTyped(checkpoint),
        this.serde.dumpsTyped(metadata),
      ]);
    if (checkpointBytes.byteLength + metadataBytes.byteLength > MAX_BYTES)
      throw new Error("Conversation checkpoint exceeds D1 row budget");
    const result = await this.db
      .insert(checkpoints)
      .select(
        this.db
          .select(
            insertSelectFields(checkpoints, {
              threadId: sql`${this.scope.threadId}`,
              namespace: sql`${namespace}`,
              checkpointId: sql`${checkpoint.id}`,
              parentId: sql`${id || null}`,
              checkpointType: sql`${checkpointType}`,
              checkpoint: sql`${buffer(checkpointBytes)}`,
              metadataType: sql`${metadataType}`,
              metadata: sql`${buffer(metadataBytes)}`,
            }),
          )
          .from(chatConversations)
          .where(
            and(
              eq(chatConversations.threadId, this.scope.threadId),
              this.accessPredicate(),
            ),
          ),
      )
      .onConflictDoUpdate({
        target: [
          checkpoints.threadId,
          checkpoints.namespace,
          checkpoints.checkpointId,
        ],
        set: {
          parentId: id || null,
          checkpointType,
          checkpoint: sql`${buffer(checkpointBytes)}`,
          metadataType,
          metadata: sql`${buffer(metadataBytes)}`,
        },
      })
      .returning({ id: checkpoints.checkpointId });
    if (!result.length) throw new D1CheckpointAccessError();
    return {
      configurable: {
        thread_id: this.scope.threadId,
        checkpoint_ns: namespace,
        checkpoint_id: checkpoint.id,
      },
    };
  }
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath = "",
  ): Promise<void> {
    const { namespace, id } = this.identity(config);
    if (!id || !taskId) throw new Error("Missing checkpoint write identity");
    if (writes.length > 128)
      throw new Error("Checkpoint write set exceeds D1 batch budget");
    const encoded = await Promise.all(
      writes.map(async ([channel, value], index) => {
        const [type, data] = await this.serde.dumpsTyped(value);
        return { channel, index: WRITES_IDX_MAP[channel] ?? index, type, data };
      }),
    );
    if (
      encoded.reduce((size, row) => size + row.data.byteLength, 0) > MAX_BYTES
    )
      throw new Error("Checkpoint writes exceed D1 batch budget");
    const token = crypto.randomUUID();
    const statements: D1Query[] = [
      this.db.insert(receipts).select(
        this.db
          .select(
            insertSelectFields(receipts, {
              token: sql`${token}`,
              kind: sql`'checkpoint_writes'`,
              resourceId: sql`0`,
            }),
          )
          .from(chatConversations)
          .where(
            and(
              eq(chatConversations.threadId, this.scope.threadId),
              this.accessPredicate(),
            ),
          ),
      ),
    ];
    const update = writes.every(([channel]) => channel in WRITES_IDX_MAP);
    for (const row of encoded) {
      const statement = this.db.insert(checkpointWrites).select(
        this.db
          .select(
            insertSelectFields(checkpointWrites, {
              threadId: sql`${this.scope.threadId}`,
              namespace: sql`${namespace}`,
              checkpointId: sql`${id}`,
              taskId: sql`${taskId}`,
              index: sql`${row.index}`,
              taskPath: sql`${taskPath}`,
              channel: sql`${row.channel}`,
              valueType: sql`${row.type}`,
              value: sql`${buffer(row.data)}`,
            }),
          )
          .from(receipts)
          .where(eq(receipts.token, token)),
      );
      const target = [
        checkpointWrites.threadId,
        checkpointWrites.namespace,
        checkpointWrites.checkpointId,
        checkpointWrites.taskId,
        checkpointWrites.index,
      ];
      statements.push(
        update
          ? statement.onConflictDoUpdate({
              target,
              set: {
                taskPath,
                channel: row.channel,
                valueType: row.type,
                value: sql`${buffer(row.data)}`,
              },
            })
          : statement.onConflictDoNothing({ target }),
      );
    }
    statements.push(
      this.db
        .select({ token: receipts.token })
        .from(receipts)
        .where(eq(receipts.token, token)),
      this.db.delete(receipts).where(eq(receipts.token, token)),
    );
    const results = await runD1Batch(this.database, statements);
    if (!results[results.length - 2].results.length)
      throw new D1CheckpointAccessError();
  }
  async deleteThread(threadId: string): Promise<void> {
    if (threadId !== this.scope.threadId) throw new D1CheckpointAccessError();
    const token = crypto.randomUUID();
    const results = await runD1Batch(this.database, [
      this.db.insert(receipts).select(
        this.db
          .select(
            insertSelectFields(receipts, {
              token: sql`${token}`,
              kind: sql`'checkpoint_delete'`,
              resourceId: sql`0`,
            }),
          )
          .from(chatConversations)
          .where(
            and(
              eq(chatConversations.threadId, threadId),
              this.accessPredicate(),
            ),
          ),
      ),
      this.db
        .delete(checkpointWrites)
        .where(
          and(eq(checkpointWrites.threadId, threadId), this.receipt(token)),
        ),
      this.db
        .delete(checkpoints)
        .where(and(eq(checkpoints.threadId, threadId), this.receipt(token))),
      this.db
        .select({ token: receipts.token })
        .from(receipts)
        .where(eq(receipts.token, token)),
      this.db.delete(receipts).where(eq(receipts.token, token)),
    ]);
    if (!results[3].results.length) throw new D1CheckpointAccessError();
  }
}
