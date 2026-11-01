---
slug: /
sidebar_label: はじめに
description: VideoQ に初めて参加する人のための、セットアップ・基本概念・開発ガイド。
---

# VideoQ 開発ドキュメント

VideoQ は、**受講生の質問に講義動画の内容から自動で回答し、根拠となる場面へ案内するサービス**です。講座の運営者や講師が動画を講座にまとめて共有し、受講生が質問して引用された場面へ移動します。

このサイトは、初めて開発に参加する人が、アプリを動かし、小さな変更を進められるようにするための案内です。すべての設計図を先に読む必要はありません。

## AIの仕組みを知る

[AIが回答を作るまで](concepts/how-ai-works.md)では、一つの質問から検索・根拠の取得・回答・引用元の再生までを追えます。AIが何を読み、過去の会話をどこまで受け取るかも説明しています。

詳しく知りたい場合は、[文字起こしとシーン検索](architecture/transcription-and-search.md)、[Q&Aのプロンプトと回答の保存](architecture/prompt-engineering.md)へ進んでください。これらの解説は、メニューの「AIの仕組み」にまとめています。

[AIの手法と参考文献](reference/ai-references.md)に、原論文・モデルの公式資料、実装との対応、再利用できるBibTeXをまとめています。

現在は、**質問ごとに独立したQ&A・ツールによる情報取得・構造化回答**を使います。本文と引用を生成中から配信し、完成した講座の回答を検証後に保存します。回答後のAI採点は行いません。以前のStudyモードとPLOG学習グラフは廃止されています。[AIの全体像](concepts/how-ai-works.md)は、2026-10-31時点の実装と照合した内容です。

## 初めて参加したら

次の順に進めると、使い方と実装が結び付きます。

| 順番 | 読むページ | ここまでできれば次へ |
|---|---|---|
| 1 | [開発環境を動かす](getting-started/local-setup.md) | ローカルにログインできる |
| 2 | [動画を登録して質問する](getting-started/first-walkthrough.md) | 回答の引用から動画の場面へ戻れる |
| 3 | [コードの場所を知る](getting-started/codebase.md) | 画面・API・動画処理の担当場所が分かる |
| 4 | [最初の変更を進める](getting-started/first-change.md) | 小さな変更と、その確認結果をレビューに出せる |

文書だけの変更なら、[ドキュメントを更新する](guides/documentation.md)から始められます。

## まず知っておくこと

- **動画**は1本の教材、**講座**は質問・共有の対象となる動画のまとまりです。[データの関係を見る](concepts/domain-model.md)
- 画面はReact、APIはHono、時間のかかる動画処理はPythonが担当します。[全体像を見る](architecture/system-configuration-diagram.md)
- 動画の文字起こし・検索準備は順に進みます。登録直後にすべて使えるわけではありません。[状態の意味を見る](design/state-diagram.md)

## 作業に合わせて読む

| やりたいこと | ガイド |
|---|---|
| 画面・文言・フォームを変える | [画面を変更する](guides/frontend.md) |
| 取得・更新するデータや操作を増やす | [APIを変更する](guides/api.md) |
| テーブルや列を変更する | [DBを変更する](guides/database.md) |
| 文字起こし・索引を変える | [動画の非同期処理を変更する](guides/worker.md) |
| 変更が正しいか確かめる | [テストと確認コマンド](guides/testing.md) |
| 起動や動画処理で困っている | [困ったとき](guides/troubleshooting.md) |
| オンプレの Kubernetes に導入する | [オンプレで動かす](guides/on-premises.md) |
| LLM・埋め込み・Whisperも社内に置く | [ローカルAI推論](guides/local-inference.md) |

## 詳しく調べる

必要になったときに、左の「設計リファレンス」から各図や仕様を参照してください。DBの名前は[データ辞書](database/data-dictionary.md)、略語は[用語集](reference/glossary.md)で確認できます。
