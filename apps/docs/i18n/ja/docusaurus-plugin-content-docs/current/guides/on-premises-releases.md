---
sidebar_label: オンプレの署名付き配布と更新
description: 署名とダイジェストを検証し、Kubernetes で更新と復元を検証する手順。
---

# オンプレの署名付き配布と更新

このページで検証した配布物は、[単一サーバーへの導入](on-premises-single-server.md)と
[Kubernetes への配置](on-premises.md)の両方で使えます。
インストーラーには `verified-images.json` を渡し、Helm では検証済みの Chart も使います。
以下の Helm コマンドは Kubernetes 向けです。単一サーバーの場合は、署名検証後に導入ガイドへ戻ってください。

インターネットに接続できる導入先では、外部レジストリとイメージのダイジェストを使って配布します。`On-prem Release` は最新 main の push CI 成功を確認し、Linux amd64・arm64 の API、Web、ワーカー、CPU Whisper、アプリ・推論用の両 Helm Chart、`release.json` を作成します。NVIDIA vLLM のイメージは amd64 用として同梱します。同じ main コミットで手動実行すると、OS パッケージ修正後の再ビルドにも使えます。

配布用の `ghcr.io/videoq-jp/videoq-api`・`videoq-worker`・`videoq-web`・`videoq-transcription-gateway` は Public とします。Docker や Kubernetes からは GHCR のログインや `imagePullSecrets` なしで取得できます。導入先独自の非公開レジストリを使う場合は、引き続き `imagePullSecrets` を設定できます。各イメージにはリポジトリの現行 LICENSE を同梱し、公開範囲の変更でライセンス条件は変更しません。

パッケージ管理者が初期設定で Public にし、**Package settings → Manage Actions access** で `videoq-jp/videoq` に **Write** を付与します。CI は push の前後とインデックス作成前に公開状態を確認し、非公開・internal・未作成の場合は配布を止めます。署名を検証した配布物は、空の Docker 認証設定で取得して匿名アクセスを確認します。公開済みパッケージを Private に戻すことは GitHub の仕様上できません。push 用の書き込み認証は引き続き必要です。

## 配布時に確認すること

アプリのビルドはリポジトリの読み取り権限だけで実行します。各イメージの未修正分を含む HIGH・CRITICAL 脆弱性を検査し、イメージと CycloneDX SBOM を保存します。別の新しいランナーで、そのイメージを実行せずに配布し、GitHub OIDC による来歴とアーキテクチャ別 SBOM の署名を付けます。両アーキテクチャを束ねるイメージインデックス、Chart のバイト列、全4イメージのダイジェストと対応アーキテクチャも署名対象です。上流 vLLM は別の必須ワークフローで検査し、イメージを変更せず採用します。未評価の HIGH・CRITICAL・UNKNOWN は配布を止め、生の検査結果と適用性評価を90日間保存します。

API とワーカーはダイジェスト固定の Alpine イメージを使い、既存の Runtime Updates がインタープリターと npm・pip・uv の検証済み配布物を更新します。ベース変更には、Python wheel、PostgreSQL、FFmpeg、認証、Kubernetes の検証を必要とします。リリースの各実行・再試行には別のレジストリタグを使い、導入時はダイジェストを指定します。

`On-prem Validation` は関連変更時と毎日 main に対して実行し、脆弱性の再検査と使い捨て Kubernetes での検証を行います。配布後にも署名を検証して同じ検証環境を動かします。本番への反映は運用担当者が承認します。未修正という理由で脆弱性をまとめて除外しません。

## 配布物を取得して検証する

`gh attestation verify` に対応した GitHub CLI、Python 3.9 以上、Helm 4.3.1 を用意します。検証スクリプトはレビュー済みのチェックアウトから実行します。成功した `On-prem Release` の実行 ID と、別途確認した完全なソースコミット SHA を使ってください。ダウンロードした manifest 自体から信頼する SHA を決めないでください。

```sh
SOURCE_SHA=REPLACE_WITH_REVIEWED_40_CHARACTER_COMMIT
RUN_ID=REPLACE_WITH_SUCCESSFUL_RELEASE_RUN
RUN_ATTEMPT=$(gh run view "$RUN_ID" --repo videoq-jp/videoq --json attempt --jq .attempt)
mkdir -p /secure/videoq-release
gh run download "$RUN_ID" --repo videoq-jp/videoq \
  --name "onprem-release-$SOURCE_SHA-attempt-$RUN_ATTEMPT" --dir /secure/videoq-release
python3 .github/scripts/onprem-release.py verify "$SOURCE_SHA" \
  /secure/videoq-release/release.json /secure/videoq-release/verified-images.json \
  /secure/videoq-release/verified-inference.json
```

イメージの取得に GHCR のログインや `read:packages` 資格情報は不要です。上記の GitHub CLI の認証は、ワークフロー成果物のダウンロードと署名検証に使います。検証スクリプトは署名、対象ファイル、リポジトリ、配布ワークフロー、`refs/heads/main`、ソースコミット、GitHub ホストのランナーであることを確認します。manifest、両 Chart のチェックサムと署名、全4イメージの署名がすべて正しい場合だけ、アプリ用・推論用の Helm 設定ファイルを生成します。失敗時は既存の値を保持します。

アーキテクチャ別 SBOM は、`gh attestation verify` の predicate に `https://cyclonedx.org/bom` を指定して確認できます。Chart、manifest、確認済みの値、SBOM、署名バンドルを保管してください。ワークフローの成果物は 90 日で期限切れになります。採用したイメージのダイジェストと署名をレジストリの削除ポリシーから保護します。

検証済みのイメージ指定は **最後** に読み込みます。

```sh
helm template videoq /secure/videoq-release/videoq-0.1.0-sha.$SOURCE_SHA.tgz \
  -n videoq -f /secure/site.yaml -f /secure/videoq-release/verified-images.json
helm upgrade --install videoq /secure/videoq-release/videoq-0.1.0-sha.$SOURCE_SHA.tgz \
  -n videoq -f /secure/site.yaml -f /secure/videoq-release/verified-images.json \
  --wait --timeout 15m
helm test videoq -n videoq --timeout 2m
```

完全オンプレでは、[ローカル AI 推論](local-inference.md)に従い、推論用 Chart に `verified-inference.json` を最後に重ねます。NVIDIA のチャット・埋め込み・文字起こしは、署名付き Chart 内でダイジェスト固定した同じ上流 vLLM イメージを使います。vLLM の再ビルド・再配布は行いません。アプリ用 Chart は対応するローカル設定の後に `verified-images.json` を重ねます。標準設定はホスト型の OpenRouter のため、ローカル設定の適用が必要です。

Chart が強制するのはダイジェスト指定です。署名確認は導入側のスクリプトで行うため、クラスタ管理者による回避も防ぐ必要があれば、同じ署名者を条件とする admission policy を導入先で設定します。

NVIDIA の上流イメージと別ボリュームの音声依存を Trivy で検査し、未加工の検出結果を保持します。実ファイル・起動引数・権限・期限に一致する[適用性評価](https://github.com/videoq-jp/videoq/blob/main/apps/inference/vllm/security/README.md)のみを認め、未評価の HIGH・CRITICAL・UNKNOWN はリリースを止めます。`upstream-vllm-inspection-*` の artifact は、生の検査結果・実ファイル一覧・実行検証・依存ロック・評価を90日間保持します。

## 検証環境から本番へ進める

独立した検証用 namespace と DB・ストレージ・キューを用意します。ソース SHA、配布実行 ID、Chart のチェックサム、各イメージのダイジェスト、サイト設定の版、DB マイグレーションの版を記録します。代表的なバックアップを復元し、アップロード、文字起こし、索引、引用付き Q&A、SSE、時刻指定の再生を確認した後、同じ配布物の本番導入を承認します。

GitOps を使う場合は、署名確認後の `verified-images.json` をレビュー可能な PR に保存し、承認済みの値を検証環境に同期させます。本番への反映は同じダイジェストを承認して進めます。導入先が未定の間は、このリポジトリにサイトへの接続資格情報を設定しません。

## ローカルで更新と復元を再現する

API、ワーカー、Web をそれぞれ `videoq-api:onprem-ci`、`videoq-worker:onprem-ci`、`videoq-web:onprem-ci` としてビルドし、Docker・kind・kubectl・Helm・Node・Python のある環境で実行します。

```sh
npm ci --ignore-scripts --workspaces=false
kind create cluster --name videoq-onprem-lab --kubeconfig /tmp/videoq-lab-kubeconfig
HELM_BIN=helm python3 .github/scripts/onprem-lab.py \
  /tmp/videoq-lab-kubeconfig /tmp/videoq-lab-results
kind delete cluster --name videoq-onprem-lab --kubeconfig /tmp/videoq-lab-kubeconfig
```

専用クラスタ内に検証専用の PostgreSQL/pgvector、Garage、ElasticMQ、固定応答の推論 API を作成します。アップロード、実際の FFmpeg 音声抽出、キュー配信、文字起こし保存、索引、引用付き Q&A、SSE を通し、S3 データのバックアップ・削除・復元とチェックサム一致を確認します。DB を別の DB に復元して接続先を切り替え、API を 2 Pod に更新し、Helm テストと 1 Pod へのロールバック後にもデータを利用できることを検証します。すべて成功した場合だけ `result.json` が作成されます。資格情報を含む DB ダンプはコミットしません。

実モデルの認識・回答精度、GPU の性能、TLS・Ingress、ホスト障害時のストレージ・キューの永続性、バックアップの RPO/RTO は、導入先で別途検証してください。

## 実際の CPU モデルで検証する

配布ワークフローの `Real CPU models with public egress blocked` は、署名検証後のアプリ・Whisper と、推論用 Chart に固定した llama.cpp を使います。モデルの版とチェックサムを検証し、導入時の取得を終えてから、専用の Docker ネットワーク上に使い捨て kind クラスタを作成します。kind の起動にはデフォルトゲートウェイが必要なため、起動とイメージ配置後に専用ノードの IPv4・IPv6 の OUTPUT／FORWARD を制限し、公開 IP と Docker ホストへの新規接続を遮断します。外部への DNS 転送も止め、遮断の適用後に動画処理を開始します。実際のワーカー Pod から社内の推論サービスに接続できる一方、外部 IP・DNS に接続できないことを確認します。

公開の日本語 FLEURS 音声を動画にしてアップロードし、whisper.cpp による文字起こし、llama.cpp による埋め込み・引用付き回答・SSE、Chromium での引用時刻からの動画再生を確認します。DB 復元・更新・ロールバック後も回答を確認します。認識結果、回答、処理時間、再生結果、モデルのチェックサム、イメージのダイジェストを `onprem-cpu-acceptance-*` 成果物に90日間保存します。資格情報・モデル本体・DB ダンプは含めません。

字幕の時刻が元動画の範囲内にあり、参照文との正規化文字誤り率（CER）が 0.25 未満であることも確認します。

検証用の PostgreSQL・S3・キューは、元のダイジェストで取得した後にローカルの別名を付けて kind に読み込み、`imagePullPolicy: Never` で起動します。通信遮断後に外部のマルチアーキテクチャ用インデックスを再取得しないための検証環境専用設定です。元の参照と Docker イメージ ID は結果に残し、導入先では引き続き署名検証済みのダイジェストを使います。失敗時は Pod・ノードの状態と警告イベントを記録し、Pod の設定全体や Secret は含めません。

containerd を使う Docker では、実行 CPU 向けだけを書き出して取り込みます（Docker API 1.48 以上）。従来形式のイメージ保存領域では、実行 CPU と一致することを確認します。通信を遮断する前に各別名がノードの CRI キャッシュで解決できることを確認し、取り込んだプラットフォームと CRI イメージ ID を記録します。

```sh
npm ci --ignore-scripts --workspace @videoq/api --workspace @videoq/web
node node_modules/playwright/cli.js install --with-deps chromium
HELM_BIN=helm python3 .github/scripts/onprem-cpu-acceptance.py \
  "$SOURCE_SHA" /secure/videoq-release /tmp/videoq-real-cpu-results
```

既存の `videoq-onprem-lab` クラスタがあれば置き換えずに停止します。モデル取得時にはインターネット接続が必要です。検証用の DB 等も含め、少なくとも16 GiB の RAM を用意します。短い公開サンプル1件での確認なので、導入先の日本語録画・同時利用数による精度や性能、CNI による NetworkPolicy の適用確認は別途必要です。


## パッケージ名と過去のリリース

名前空間の移行は完了しています。通常の **On-prem Release** が
`videoq-jp/videoq-api`・`videoq-worker`・`videoq-web`・
`videoq-transcription-gateway` の公開4パッケージを配布します。
Public設定と、このリポジトリに対するActions Write権限を維持してください。
bootstrapタグは導入用のリリースではありません。

移管時だけ使ったPackage Namespace BootstrapとRetired Package Cleanupの
ワークフローは廃止しました。過去のパッケージ・リリース・署名は削除せず、
ロールバックと検証のために保持します。過去のスキーマでも元のリポジトリ・
ワークフロー・コミットを固定し、8件の署名を検証します。
名前空間を混在させた配布物は拒否します。新しい配布には通常の署名付きリリースを使ってください。
