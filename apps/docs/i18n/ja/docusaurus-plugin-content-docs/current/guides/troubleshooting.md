---
title: 困ったとき
description: 起動・ログイン・動画処理・検索でつまずいたときの確認場所。
---

# 困ったとき

まず「画面」「API」「DB」「動画処理」のどこまで動いているかを確認します。最初からDBを作り直す必要はありません。

## 最初に見る3つの情報

```bash
docker compose ps -a
docker compose logs --tail=100 migrate api worker
curl -i http://localhost/ready
```

`migrate` と `garage-init` の終了コード `0` は正常です。`/health` は成功して `/ready` が失敗するなら、API自体は応答しており、DB接続やmigrationを確認する段階です。

## 画面が開かない・変更が反映されない

| 症状 | 確認すること |
|---|---|
| `localhost` が開かない | `gateway` と `web` の起動。ポート80を別アプリが使っていないか |
| 画面は開くがAPIが失敗する | `/health`、`/ready`、`api` のログ |
| 編集しても画面が変わらない | `localhost` は静的ビルド。`web-dev` を起動して `localhost:3000` を開く |
| ポート3000で起動できない | Composeの `web-dev` とホストのViteを同時に起動していないか |
| 文書の検索が動かない | `npm run build:docs` の後に `npm run preview:docs` で確認する |

## ログインできない

メール未設定のローカル環境なら、[セットアップのアカウント昇格](../getting-started/local-setup.md)を確認します。先にサインアップしていないと、昇格対象が見つかりません。

移行済みのローカルアカウントで `Password not found` が出る場合は、次の復旧用コマンドがあります。

```bash
npm run user:password:local --workspace @videoq/api -- your-username
```

ローカル用の一時パスワードが表示されます。共有環境や本番のログイン問題にそのまま使わないでください。

ローカルでログイン試行のレート制限に当たった場合は、APIを停止してからRateLimiterのローカル状態をリセットし、APIを再起動します。実行条件は [reset-rate-limit.sh](https://github.com/videoq-jp/videoq/blob/main/apps/api/scripts/reset-rate-limit.sh)を確認してください。

## 動画の処理が進まない

まず動画IDと状態を控え、`worker` のログを確認します。

| 状態・症状 | 確認先 |
|---|---|
| `uploading` のまま | ブラウザからGarageへの送信、ポート9000、アップロード完了通知 |
| `pending` のまま | `worker` と `elasticmq` の起動、APIのジョブ配送ログ |
| `processing` で失敗 | 音声の有無、FFmpeg・Whisperのログ、AIキー |
| `indexing` で失敗 | 埋め込みモデル・次元、DB接続、workerの例外 |
| YouTubeだけ失敗 | 設定画面のTranscriptAPIキーと取得対象の字幕 |
| サイズ・利用量で拒否される | Adminのアップロード上限・保存容量・月間利用量 |

状態の意味は[動画の状態遷移](../design/state-diagram.md)で確認できます。

## 検索できない・回答に引用がない

1. 質問先の講座に動画が含まれているか確認します。
2. 対象動画が `completed` で、文字起こしがあるか確認します。
3. [埋め込み診断コマンド](embeddings.md)でAPI・workerの `EMBEDDING_BASE_URL`・`EMBEDDING_MODEL` を照合します。次元は1536固定です。ログの内部理由から設定・DB・出力のどこに不整合があるか確認します。
4. 埋め込みモデルを変更した場合は、[既存データの移行制約](embeddings.md#モデルの整合性)を確認します。次元が同じでも旧ベクトルとの互換性は保証されません。全体再索引は動画単位で置き換えるため、途中失敗すると異なるモデルのデータが混在する場合があります。

講座名や動画本数などの質問は、登録情報だけで回答し、シーン引用がない場合があります。内容の質問でも動画に根拠がなければ、期待した回答が得られるとは限りません。

## 回答の配信が失敗する・引用が後から表示される

ReActチャットは、回答ごとに作られる `CHAT_EXECUTION` Durable Objectで実行します。入口のWorkerは元の要求と応答ストリームを解析せず転送します。認証・講座のアクセス確認・利用枠の予約・ツール実行・最終回答の保存は、従来と同じAPIハンドラで処理します。SSEとtRPCの `chat.send` が対象で、`chat.send` を含むバッチも同じ経路を使います。

Workers Freeの通常リクエストは **CPU上限10ms**、SQLite版Durable Objectsは既定で **CPU上限30秒** です。モデルの応答待ちではなく、実際の計算時間を数えます。ツールを繰り返す処理を通常の無料Workerで安定して実行することは難しいため、実行環境を分けています。この経路に有料契約やDB migrationは不要で、デプロイ時にWranglerがSQLite版の新しいクラスを作成します。Cloudflareの [Worker上限](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)、[Durable Object上限](https://developers.cloudflare.com/durable-objects/platform/limits/)、[1日ごとの無料枠](https://developers.cloudflare.com/durable-objects/platform/pricing/)を参照してください。無料枠を超えるとリセットまで処理が停止し、無料プランでは超過料金は発生しません。

応答がHTMLになったり途中で途切れたりした場合は、Cloudflareの **Workers & Pages → API Worker → Observability → Events** で失敗した呼び出しを確認します。`Worker exceeded CPU time limit` / `exceededCpu` は、アプリのエラーハンドラが動く前も含め、実行基盤が強制終了したことを示します。入口のWorkerと `ChatExecution` の両方を確認してください。実際にツールを使う質問を送り、`done` と履歴保存まで確認します。`/health` だけでは検証できません。ほかのAPIは通常のWorkerで動くため、CPU上限に達する場合は別途原因を調べます。

| 症状 | 確認すること |
|---|---|
| `LLM_CONFIGURATION_ERROR` | APIのサーバーキーと、設定した接続先・モデルがstrictな `json_schema` 出力とstrictな関数ツールの同時利用に対応しているか |
| 本文より先に検索進捗が表示される | 回答生成の前に資料を取得する。ツール呼び出し前の前置きは表示しない |
| 文章より後に引用が付く | segmentが閉じ、出典IDと数式・コードの境界が検証される必要がある |
| 本文が表示された後に失敗する | プロバイダーの拒否・出力トークン上限による途中終了・不正な最終JSON・本文生成後のツール呼び出し・配信中断。途中の表示は保存済みの回答ではない |
| 本文の表示後も履歴やフィードバックが使えない | 最終検証と保存を確認する。SSEで `done` を受信し、描画待ちの内容を反映する必要がある |

画面は固定の文字送りタイマーではなく、描画フレームに合わせて更新します。`done` は回答の保存完了を表します。イベントの順序と利用枠は[ストリームの契約](../architecture/prompt-engineering.md#ストリームの契約)を参照してください。

## 字幕を直したのに古い回答が出る

字幕の保存と、非同期の検索再索引の完了は別です。元からある動画の `completed` 表示では、今回の再索引が終わったかは分かりません。該当するworkerジョブを確認してから、新しいQ&Aの質問を送ります。以前に表示・保存された回答は変わりません。

## 設定を変えたのに変化がない

Composeの `.env` は起動済みプロセスに自動反映されません。

```bash
docker compose up -d --force-recreate api worker
```

API側に転送される変数は [docker-dev.sh](https://github.com/videoq-jp/videoq/blob/main/apps/api/scripts/docker-dev.sh)で限定されています。任意の変数を `.env` に追記しただけではAPIから読めない場合があります。

## チームに相談するとき

試した操作、画面のURL、動画ID、期待した結果、実際の状態、関係するログの時刻やrequest IDを共有すると原因を追いやすくなります。ログからキー・Cookie・利用者の非公開データを除いてください。
