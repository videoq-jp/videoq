---
title: データが保存される場所
description: 動画ファイル、検索データ、質問と回答、認証情報の保管先。
---

# データが保存される場所

動画ファイル本体と、動画についての情報は別の場所に保存されます。問題を調べるときは、どちらのデータを確認すべきかを切り分けます。

## 動画から検索データへ

```mermaid
flowchart LR
    File[動画ファイル] --> Store[(R2 / Garage)]
    Store --> Worker[Python worker]
    Worker --> Transcript[(videosの文字起こし)]
    Transcript --> Index[埋め込みの生成]
    Index --> Scenes[(scene_embeddings)]
```

`videos` はタイトル、所有者、ファイルへの参照、文字起こし、処理状態などを持ちます。ファイル本体をDBの行に保存する構成ではありません。

`scene_embeddings` は文字起こしの区間を意味で検索するためのデータです。APIが質問を検索用の数値に変換し、許可された動画の中から近い場面を探します。

## 質問と回答

```mermaid
flowchart LR
    Question[質問] --> Access[講座へのアクセスを確認]
    Access --> Context[登録情報・字幕の検索]
    Context --> Answer[構造化回答と引用]
    Answer --> Browser[本文と検証済み引用を逐次配信]
    Answer --> Validate[完成した回答を検証]
    Validate --> Logs[(chat_logs.response)]
```

`chat_logs.response` は `segments` とサーバーが管理する `sources` を保存します。`retrieved_contexts` には重複除去済みのシーン本文と取得した講座情報を保存します。途中のストリームイベントを別のチャット記録として保存することはありません。

ストリームの `done` は回答保存後に送信します。講座未選択の応答は履歴に保存しません。廃止前の評価テーブルは過去データとして残り、新しい評価は作成しません。

## その他の保存先

| データ | 保存先・管理する仕組み |
|---|---|
| ブラウザのログイン状態 | Better Authの `session` とブラウザCookie |
| ユーザーが保存した外部APIキー | DB内に暗号化して保存 |
| MCPのAPIキー・OAuth | `apikey`、`oauth_*` など |
| 未配送のジョブ | `external_tasks` |
| workerの実行記録 | `job_executions` |
| 文字起こし・画像キャッシュのチェックポイント | `video_transcription_*`、`video_visual_*` |
| アップロード動画の画像キャッシュ | R2 / Garage内の非公開オブジェクト `media/<file_key>.frames-v1.json`、`.focus-v1.bin` |

**関連:** [データ辞書](data-dictionary.md)、[ER図](er-diagram.md)、[ジョブの配送と回復](../architecture/flowchart.md)。
