---
sidebar_label: 単一サーバーへの導入
description: 1台の Linux サーバーで VideoQ を導入・評価し、バックアップ・更新・復元する。
---

# VideoQ を1台のサーバーに導入する

まず1台の Linux サーバーで、導入・動画処理・Q&A・更新・復旧を確認します。インストーラーが Web・Node.js API・Python ワーカーに加え、PostgreSQL・動画ストレージ・永続キューを配置します。既存の Kubernetes や社内の DB・ストレージを利用する場合は、[Kubernetes 向けの導入手順](on-premises.md)へ進んでください。

保存先は単一サーバー上の1レプリカです。サーバー障害に備え、評価中もバックアップを別ホストに保管します。

## 導入前の準備

| 用意するもの | 用途 |
|---|---|
| Linux・Docker Engine・Docker Compose・Python 3.9 以降 | インストーラーと各サービスの実行 |
| ソースコードのチェックアウト | `scripts/onprem/videoq.py` と設定テンプレート |
| 検証済みの `verified-images.json` | 使用する配布イメージの固定 |
| アプリとストレージの公開 URL | ブラウザーからログイン・アップロード・再生する経路 |
| OpenRouter のキー、または既存のローカル推論サービス | チャット・埋め込み・文字起こし |

[リリースの取得と署名検証](on-premises-releases.md)を先に行い、生成された `verified-images.json` を使います。イメージの自前ビルドは不要です。リリースの検証に必要なツールは、リリースガイドで確認してください。

アプリとストレージの URL は別のオリジンにします。DNS 名を分けるか、同じ名前の別ポート（例: `https://videoq.example.edu` と `https://videoq.example.edu:9443`）を使えます。DNS は導入先サーバーへ向けます。

HTTPS は Caddy が証明書を自動取得します。そのための DNS・証明書発行先への接続を用意してください。独自 CA を使う場合は `install` または `init` に `--tls-cert /secure/site.crt --tls-key /secure/site.key` を指定します。PEM 証明書は両方のホスト名を含み、ブラウザーと診断を実行するサーバーで発行元 CA を信頼する必要があります。CLI には `SSL_CERT_FILE=/secure/ca-chain.pem` でも指定できます。

入口には URL で指定したポートを公開します。通常は 80/443 です。HTTPS では証明書の検証とリダイレクト用に 80 も公開します。ホスト側のプロキシ経由で使う場合は `--bind-address 127.0.0.1` でループバックに限定できます。省略時は全インターフェースで公開します。

## インストール

未取得の場合は、リポジトリをチェックアウトします。

```sh
git clone https://github.com/videoq-jp/videoq.git
cd videoq
```

以降のコマンドはリポジトリのルートで実行します。検証済みリリースと生成する設定はチェックアウトの外に保存します。公開 URL と管理者情報を置き換えて実行してください。

```sh
python3 scripts/onprem/videoq.py --directory /secure/videoq-server install \
  --images /secure/videoq-release/verified-images.json \
  --url https://videoq.example.edu --storage-url https://s3.example.edu \
  --username site_admin --email admin@example.com
```

標準構成では OpenRouter のキーを非表示で入力します。`install` は設定・秘密鍵の生成、基盤とアプリの起動、接続診断、初期管理者の設定リンク発行まで進めます。リンクを管理者本人が開き、パスワードを設定してください。オンプレ版には公開サインアップがありません。

設定生成後に失敗した場合は、同じ保存先で `init` をやり直さず、以下の診断・再開手順を使います。既存の保存先への初期化は拒否され、暗号鍵は上書きされません。

## 診断と再開

設定を先に確認したい場合は、次の `init` で生成してから起動します。管理者情報は最後の `admin` で指定します。

```sh
python3 scripts/onprem/videoq.py --directory /secure/videoq-server init \
  --images /secure/videoq-release/verified-images.json \
  --url https://videoq.example.edu --storage-url https://s3.example.edu
python3 scripts/onprem/videoq.py --directory /secure/videoq-server doctor
python3 scripts/onprem/videoq.py --directory /secure/videoq-server start
python3 scripts/onprem/videoq.py --directory /secure/videoq-server status
python3 scripts/onprem/videoq.py --directory /secure/videoq-server doctor --live
python3 scripts/onprem/videoq.py --directory /secure/videoq-server admin \
  --username site_admin --email admin@example.com
```

`doctor` は Docker・構成・空きディスクを確認します。`--live` を付けると、S3 の認証と CORS、キューの実行リースとデッドレター設定、API の準備状態、公開 URL の DNS・TLS・アップロード用 CORS も確認します。`--live --ai` はチャット・埋め込み API のモデル一覧を確認しますが、推論や品質評価は行いません。

起動エラーには `logs --service api`、マイグレーションには `logs --service migrate`、動画処理には `logs --service worker` を使います。いずれも `--directory` はサブコマンドの前に指定します。Docker に管理者権限が必要な環境では `VIDEOQ_DOCKER_SUDO=1` を設定します。CLI は `sudo -n docker` を使用し、パスワード入力は要求しません。

自動化では `VIDEOQ_OPENROUTER_API_KEY` で標準構成のキーを渡せます。設定とバックアップには秘密情報が含まれます。`runtime.env` の暗号鍵は既存のユーザー設定の復号に必要です。共有ログには、認証情報を展開する `docker compose config` の出力を載せないでください。構成チェックには `--quiet` を使います。

## バックアップと復元

バックアップはアプリの書き込みと基盤を停止して行います。作業時間を確保し、新しい保存先を指定してください。

```sh
python3 scripts/onprem/videoq.py --directory /secure/videoq-server backup \
  --output /secure/backups/videoq-2026-11-04
python3 scripts/onprem/videoq.py --directory /secure/videoq-restored restore \
  --backup /secure/backups/videoq-2026-11-04
python3 scripts/onprem/videoq.py --directory /secure/videoq-server stop
python3 scripts/onprem/videoq.py --directory /secure/videoq-restored start
```

バックアップは5つの永続ボリュームと設定・暗号鍵を保存し、完了後に元のサービスを再開します。マニフェストはアーカイブが完成してから書き込まれます。復元先は新規ディレクトリ・別ボリュームですが、公開 URL は元と同じなので、起動前に元の構成を停止します。

バックアップは暗号化されていません。アクセスを制限し、別ホストにも保管してください。復元には信頼できるバックアップを使います。SHA-256 は破損検出用で、作成者を認証するものではありません。物理 DB バックアップの復元には、同じ PostgreSQL メジャーバージョンとアーキテクチャが必要です。

## 更新

[リリースガイド](on-premises-releases.md)で新しいリリースを検証し、更新前バックアップの新しい保存先を指定します。

```sh
python3 scripts/onprem/videoq.py --directory /secure/videoq-server update \
  --images /secure/new-release/verified-images.json \
  --backup /secure/backups/videoq-before-update
```

停止前にイメージを取得し、停止中にバックアップ・イメージの切り替え・マイグレーション・起動確認を行います。失敗時はアプリを停止したままにします。`logs --service migrate` と `logs --service api` で原因を確認し、解消後に `start` で再試行するか、更新前バックアップを新しいディレクトリへ復元します。SQL スキーマ変更後にイメージだけを自動で戻す処理はありません。

## ローカル AI への接続

`install` または `init` に `--ai local-cpu` / `--ai local-gpu` と、`--chat-url`・`--embedding-url`・`--transcription-url` を `/v1` まで含めて指定します。既存のプライベート推論サービスへの接続設定です。モデルや GPU ドライバーを自動構築するものではありません。[ローカル推論](local-inference.md)で対応するサービスを用意してください。

モデルの標準値は Helm の `local-ai-llamacpp.yaml` / `local-ai-vllm.yaml` と一致します。必要に応じて `--chat-model` / `--embedding-model` を指定します。共通の API キーは `VIDEOQ_LOCAL_AI_KEY` で渡し、認証不要の場合は `local-inference` を使います。ローカル設定では外部 AI のキーと接続先を除き、画像を使う Q&A を無効にします。

既存データの埋め込みモデルを変更する場合は、次元数が同じでも再索引が必要です。CLI は外部通信を遮断するファイアウォールを構成しません。また、`start --offline` は明示的な pull を省略するだけです。アプリ・基盤の全イメージを事前に搬入する必要があり、完全な閉域網向け配布セットは生成しません。

## 単一サーバーでの評価を終える前に

導入先で使う AI と、実際の用途に近い短い動画で確認します。

1. 管理者の設定リンクからログインし、動画をアップロードする。
2. 文字起こし・索引の完成後に質問し、引用された時刻から再生する。
3. 処理時間・同時利用・保存容量の増加・回答品質を記録する。
4. バックアップを別ホストにも保存し、復元と更新を試す。

自動テストは実際の動画処理・引用回答・再生・更新失敗後の復旧を、固定応答の AI サービスで確認します。導入先のモデルの品質や処理能力の承認ではありません。実 CPU モデルの確認は[署名付きリリースの検証](on-premises-releases.md)で別途行います。

この評価で不足が見えた段階で、推論・ワーカー・ストレージなどを別サーバーへ分ける必要があるか判断してください。すべてを1台で動かしている間も、バックアップは別の保存先に残します。
