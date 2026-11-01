# コンポーネント図

画面の操作からDB・動画処理まで、どの部品が呼び出されるかを示します。
各箱の実装場所を探すときは[コードの場所](../getting-started/codebase.md)、
責任の分け方を判断するときは[モジュールの責任](class-diagram.md)を参照してください。

図の矢印は主な処理の依存方向です。HTTP通信・共有する型・関数呼び出しをまとめて表しています。

## 全体

```mermaid
flowchart LR
    UI[Reactの画面] --> Hooks[データ取得フック / TanStack Query]
    Hooks --> Client[APIクライアント]
    Client --> Contract[共有tRPC契約]
    Contract --> Adapter[Honoのハンドラー]
    Adapter --> Services[機能のサービス]
    Services --> Repositories[DBの読み書き]
    Repositories --> DB[(PostgreSQL)]
    Services --> R2[(R2)]
    Services --> SQS[SQS]
    SQS --> Tasks[Python workerのタスク]
    Tasks --> Pipelines[文字起こし・索引]
    Pipelines --> DB
    Pipelines --> R2
```

## API feature

通常の JSON API は共有 tRPC router と API adapter を通ります。

```mermaid
flowchart TD
    Request --> Hono[Hono middleware]
    Hono --> Router[tRPC router<br/>Zod input]
    Router --> Adapter[request-scoped handler]
    Adapter --> Service[feature service]
    Service --> Repository[repository]
    Repository --> Drizzle[Drizzle / SQL]
    Router --> Response[tRPC response]
```

主な feature:

- auth
- videos / courses / tags
- chat
- oauth / mcp
- membership / media
- health

OAuth、webhook、SSE、multipart、CSV、media binary は
HTTP protocol 固有のため Hono route として分離します。

## Worker

```mermaid
flowchart TD
    Event[SQS event] --> Decode[Native job decode]
    Decode --> Registry[Task registry]
    Registry --> Transcription
    Transcription --> Chunks[Interval jobs and finalizer]
    Registry --> Indexing
    Registry --> Visuals[Visual cache chunks and finalizer]
    Registry --> Reindexing
    Registry --> AccountDeletion
```

HTTP の責務は API、CPU・時間を要する処理は worker に分離します。

**関連:** [APIを変更する](../guides/api.md)、[動画の非同期処理を変更する](../guides/worker.md)。
