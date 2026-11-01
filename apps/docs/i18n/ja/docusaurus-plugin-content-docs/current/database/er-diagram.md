# ER図の読み方

テーブル同士がどうつながるかを調べるページです。まず[動画・講座・シーン](../concepts/domain-model.md)の意味を確認すると読みやすくなります。

## 記号の意味

`||` は1つ、`o{` は0個以上、`o|` は0個または1つを表します。例えば `USERS ||--o{ VIDEOS` は、1人の利用者が複数の動画を持てる関係です。

以下は主要な関係を目的別に分けた図です。全列・全制約の一覧ではありません。列の詳細は[データ辞書](data-dictionary.md)からスキーマ定義へ進んで確認してください。

## 動画と講座

```mermaid
erDiagram
    USERS ||--o{ VIDEOS : owns
    USERS ||--o{ VIDEO_COURSES : owns
    USERS ||--o{ TAGS : owns
    VIDEO_COURSES ||--o{ VIDEO_COURSE_MEMBERS : contains
    VIDEOS ||--o{ VIDEO_COURSE_MEMBERS : belongs
    VIDEOS ||--o{ VIDEO_TAGS : has
    TAGS ||--o{ VIDEO_TAGS : labels
```

`VIDEO_COURSE_MEMBERS` は講座と動画を結びます。タグも `VIDEO_TAGS` を介して動画と結びます。同じ関係の重複は一意制約で防ぎます。

## 人の参加と認証

```mermaid
erDiagram
    USERS ||--o{ SESSION : signs_in
    USERS ||--o{ ACCOUNT : authenticates
    USERS ||--o{ APIKEY : creates
    USERS ||--o{ VIDEO_COURSE_MEMBERSHIPS : joins
    VIDEO_COURSES ||--o{ VIDEO_COURSE_MEMBERSHIPS : grants
    VIDEO_COURSES ||--o{ VIDEO_COURSE_INVITATIONS : invites
```

`VIDEO_COURSE_MEMBERSHIPS` は人の参加情報です。上の図の `VIDEO_COURSE_MEMBERS`（動画の所属）とは別のテーブルです。認証関連の完全な定義は [better-auth.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/db/schema/better-auth.ts)で確認します。

## 質問と評価

```mermaid
erDiagram
    USERS ||--o{ CHAT_LOGS : asks
    VIDEO_COURSES ||--o{ CHAT_LOGS : receives
    CHAT_LOGS ||--o| CHAT_LOG_EVALUATIONS : evaluated
```

質問・回答・引用はチャットログに保存します。評価テーブルは過去の記録を保持し、新たな採点は行いません。

## 動画の検索データ

```mermaid
erDiagram
    VIDEOS ||--o{ SCENE_EMBEDDINGS : indexed
```

## 再開可能な処理

```mermaid
erDiagram
    VIDEOS ||--o| VIDEO_TRANSCRIPTION_RUNS : plans
    VIDEO_TRANSCRIPTION_RUNS ||--o{ VIDEO_TRANSCRIPTION_CHUNKS : saves
    VIDEOS ||--o| VIDEO_VISUAL_RUNS : plans
    VIDEO_VISUAL_RUNS ||--o{ VIDEO_VISUAL_CHUNKS : tracks
```

動画ごとに、種類別の現在の計画は最大1件です。動画を削除すると、外部キーのカスケードで計画とチャンクも削除されます。

## 変更する前に

業務データの定義は [modern.ts](https://github.com/videoq-jp/videoq/blob/main/apps/api/src/db/schema/modern.ts)が基準です。利用者や動画を削除した場合の関連行の扱い、重複を防ぐ制約、検索のindexを合わせて確認します。

**関連:** [DBを変更する](../guides/database.md)、[データが保存される場所](data-flow-diagram.md)。
