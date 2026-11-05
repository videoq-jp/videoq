---
sidebar_label: VPS 1台の K3s
description: 1つのコマンドで VideoQ を導入し、VPS の443番ポートで HTTPS 公開する。
---

# VPS 1台で K3s を使って VideoQ を公開する

このインストーラーは **Linux の VPS 1台で、Docker 内に k3d 経由の K3s を動かす構成専用**です。汎用の Kubernetes 構築ツールではなく、ホストへ K3s を直接インストールする処理もありません。既存の Kubernetes クラスタには [Helm 手順](on-premises.md)を使います。

1つの導入コマンドで、この単一ノードの K3s に Helm で配置します。Web・API・ワーカー・PostgreSQL/pgvector・Garage・永続キューはすべて Kubernetes で動きます。完了後は HTTPS の URL をブラウザーで直接開きます。SSH のポート転送は不要です。

## 準備する

Linux amd64 / arm64 の VPS に Docker Engine・Python 3.9 以降・curl・tar・coreutils を用意し、リポジトリのルートで実行します。アプリに加えて K3s のリソースも確保します。AI は標準で OpenRouter を使います。単一ノードにはホスト障害に対する冗長性がないため、データと鍵は別ホストにもバックアップします。

VPS 事業者のファイアウォールとホスト側のファイアウォールで、外部からの **TCP 443** を許可します。SSH の接続経路は維持してください。インストーラーはファイアウォールの規則を変更しません。公開するのは HTTPS ゲートウェイです。Kubernetes API はループバック限定で、DB・キュー・ストレージ API はクラスタ内部に置きます。

K3s とホスト上の他の監視プロセスが共存できるよう、必要な場合は `fs.inotify.max_user_instances` を1024へ引き上げ、`/etc/sysctl.d/90-videoq-k3s.conf` に保存します。ホストの前提設定なのでアンインストールでは戻しません。既存の異なる設定ファイルは上書きしません。

公開 URL を決めます。

- ドメインがある場合：A レコードを VPS に向け、`https://videoq.example.com` を使います。
- ドメインがない場合：`https://YOUR_PUBLIC_IPV4` を使います。この VPS の公開 IPv4 を指定してください。

証明書は Let's Encrypt の短期証明書を使い、443番の TLS-ALPN 検証で発行・自動更新します。公開 IPv4 も対応しているため、自己署名証明書やブラウザーの例外登録は不要です。[Let's Encrypt の案内](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)と [Caddy の issuer 設定](https://caddyserver.com/docs/caddyfile/directives/tls)を参照できます。証明書データは Kubernetes の PVC に保存します。この構成では80番と UDP 443 の開放は不要です。

## 導入する

URL を自身のドメインまたは公開 IPv4 に置き換えて実行します。

```sh
python3 scripts/onprem/k3s.py install --url https://videoq.example.com
```

不足する操作用ツールを `$HOME/.local/bin` にインストールした後、以下を順に実行します。

1. 成功したリリースの選択と、イメージ・Chart の署名検証。
2. 専用の K3s クラスタ作成、またはこの導入先のクラスタでの再開。
3. 秘密情報の生成。既存の DB 認証情報と暗号鍵は保持。
4. 永続化した基盤・HTTPS ゲートウェイ・バケットの設定。
5. Helm 導入・マイグレーション・組み込みの疎通テスト。
6. 公開 HTTPS の準備確認と、初期管理者の作成。

ソース SHA は GitHub の成功した実行から自動取得し、その SHA に対して配布物の署名を検証します。SHA の入力は不要です。OpenRouter を使う場合だけキー（非表示）を入力し、必要に応じて管理者情報を入力します。GitHub 認証と Docker の権限も必要です。認証を求められた場合はターミナルの案内に従います。

アプリと S3 のアップロードは、同じ HTTPS オリジンの443番を使います。`/videoq-media/*` は署名付きパスを書き換えずに Garage へ、それ以外のアプリ・API のパスは VideoQ へ振り分けます。動画側の応答には sandbox CSP を付け、アップロードされた文書がアプリのオリジンでスクリプトを実行できないようにします。

表示された一度限りの管理者設定リンクを開き、パスワードを設定してください。その後、短い動画で文字起こし・索引・Q&A・引用時刻からの再生を確認します。疎通テストだけでは AI の品質や動画処理能力までは評価しません。

## ローカル AI を選ぶ

初回の `install` に `--ai` を指定すると、Whisper・埋め込み・LLM をまとめて選べます。標準は `openrouter` です。

```sh
# CPU でローカル推論する
python3 scripts/onprem/k3s.py install --url https://videoq.example.com --ai local-cpu

# NVIDIA GPU でローカル推論する（GPU 対応クラスタを事前に構成）
python3 scripts/onprem/k3s.py install --url https://videoq.example.com --ai local-gpu
```

| オプション | LLM・埋め込み | Whisper |
|---|---|---|
| `--ai openrouter`（省略可） | OpenRouter | OpenRouter |
| `--ai local-cpu` | llama.cpp の CPU イメージ | 署名済みゲートウェイ + whisper.cpp の CPU イメージ |
| `--ai local-gpu` | 署名済み NVIDIA vLLM イメージ | 署名済みゲートウェイ + 同じ NVIDIA vLLM イメージ |

ローカル構成は OpenRouter キーを要求せず、推論 API はクラスタ内部にだけ配置します。アプリの接続先とモデル名も自動設定し、テキスト用モデルに合わせて画像を使う Q&A を無効にします。プロファイルは検証済みリリースの Chart から読み込み、検証済みイメージ指定を最後に重ねます。CPU は amd64/arm64、GPU は amd64 に対応します。

ローカルモデルの常駐には追加のリソースが必要です。確認した配布設定では、**推論だけで** CPU 版は 5.25 CPU・7.5 GiB RAM、GPU 版は 6.25 CPU・24.5 GiB RAM・割り当て可能な NVIDIA GPU 3基を要求します。別途アプリ・DB・クラスタの分を確保してください。インストーラーは実際の Chart の要求量とノードの空きを比較し、不足時はモデルを取得せず停止します。約4 GBの VPS にはこの CPU プロファイルを配置できません。

GPU 版は NVIDIA ドライバー、K3s の GPU runtime、device plugin、k3d への GPU パススルーが構成済みのクラスタを使います。CPU 用の標準 k3d ノードを GPU 対応として作成することはありません。事前に同じクラスタ名と保存先で GPU 対応環境を準備し、この推論 Chart が RuntimeClass を個別指定しなくても GPU を使える既定 runtime / CDI 構成であることを確認してください。構成の前提は [K3s の NVIDIA 設定](https://docs.k3s.io/advanced)と [k3d の CUDA 設定](https://k3d.io/stable/usage/advanced/cuda/)を参照してください。このインストーラーは GPU ドライバーや runtime を自動インストールしません。

初回はイメージとモデルをインターネットから取得し、モデルの版・チェックサムを固定した永続キャッシュを作ります。以降の `install` / `update` では記録した構成を使います。既存データの `--ai` 変更や、埋め込みの重み・量子化・設定が変わる更新は、再索引を計画せずに適用できません。[ローカル推論](local-inference.md)にモデルと再索引の詳細があります。

ローカル推論は別の Helm リリース `inference` で管理します。通常の `uninstall` は推論ワークロードも削除してモデルキャッシュを保持し、`--purge` はキャッシュも完全削除します。更新前バックアップにはアプリのデータ・鍵と推論設定を含めますが、再取得可能なモデルキャッシュは含めません。

## 再開と状態確認

途中で止まった場合は、表示された原因を解消して**同じコマンド**を再実行します。選択したリリースを記録し、署名を再確認して、鍵と永続データを保持します。クラスタ・PVC・既存アカウントは削除しません。失敗した段階を再試行するために、これらを削除する必要はありません。

設定・秘密情報・リリース成果物・再開状態は `$HOME/videoq-kubernetes` に保存します。`admin-setup.txt` は非公開の初期設定結果です。Git や共有ログに載せないでください。

```sh
export PATH="$HOME/.local/bin:$PATH"
export KUBECONFIG="$HOME/videoq-kubernetes/kubeconfig"
kubectl -n videoq get deployments,pods,jobs,cronjobs,pvc
kubectl -n videoq logs deployment/videoq-gateway --tail=100
kubectl -n videoq logs deployment/videoq-api --tail=100
helm status videoq -n videoq
```

`no matching resources found` がノード待機時に出ていた旧版では、ノード登録前に待機を開始していました。現在は登録から `Ready` まで最大180秒待ちます。古い出力で停止した場合は、修正済みの同じ導入コマンドを再実行してください。登録されない状態が続く場合は、K3s サーバーの containerd ログで `fsnotify`・`too many open files` を確認します。

証明書が発行できない場合は、外部から TCP 443 に到達できるか、公開 IP と DNS レコードが正しいかを確認します。導入を終わらせるために TLS の検証を無効にしないでください。自動更新のためゲートウェイは稼働させておきます。

特定のレビュー済みリリースを使う自動化では `--run-id` と `--source-sha` を指定できます。`--directory`・`--cluster`・`--username`・`--email` も任意指定です。全オプションは `python3 scripts/onprem/k3s.py --help` で確認できます。


## 更新する

```sh
python3 scripts/onprem/k3s.py update
```

成功した新しいリリースを選び、SHA を自動取得します。特定のリリースを固定する場合だけ `--run-id` と `--source-sha` を指定します。署名検証が終わるまでは稼働環境を変更しません。

書き込みと保守 CronJob を止め、DB・動画・キュー・証明書の4つの PVC と鍵・設定をコールドバックアップします。保存先は標準で `$HOME/videoq-kubernetes/backups/<日時>` です。新しい保存先を `--backup /private/new-backup` で指定できます。バックアップのチェックサムを確認してから基盤を再開し、Helm 更新・マイグレーション・公開 HTTPS/S3 の確認を行います。更新中はサービスを停止します。

マイグレーション以降に失敗した場合はアプリを再開せず、更新前バックアップと元のリリース記録を保持します。原因を直して同じ `update` コマンドを実行すると、同じ更新先とバックアップで再開します。未完了の更新を `install` で迂回することはできません。SQL やデータを自動で巻き戻す処理はありません。

## アンインストールする

アプリを削除してクラスタを停止し、データ・鍵・証明書・設定を保持する場合：

```sh
python3 scripts/onprem/k3s.py uninstall
```

後から `install` を実行すれば、保持したクラスタとデータを使って同じリリースを再導入できます。既存のアカウントも残ります。

**クラスタ・データ・鍵・証明書・設定・導入先の内部バックアップまで完全に削除する場合**：

```sh
python3 scripts/onprem/k3s.py uninstall --purge
```

確認のためクラスタ名を入力します。自動化では `--yes` で確認を省略できます。操作対象は `--directory` で選んだ導入先に限定し、別のクラスタや操作用ツール、ソースコードは削除しません。明示的に導入先の外へ保存したバックアップも残します。必要なバックアップは完全削除前に別ホストへコピーしてください。

## 運用と別の導入方法

PostgreSQL・オブジェクト・キュー・秘密情報・クラスタ状態を別ホストにもバックアップし、復元を試します。Helm の rollback は SQL マイグレーションやデータを戻しません。別のリリースには `update` を使います。公開 URL の変更には移行計画が必要です。`install` は記録した導入の再開です。

既存クラスタには [Helm 手順](on-premises.md)、社内 AI には[ローカル推論](local-inference.md)、配布物の方針には[署名付きリリース](on-premises-releases.md)を参照してください。
