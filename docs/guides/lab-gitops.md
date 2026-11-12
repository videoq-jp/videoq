# 研究室の RTX 4090 を Ansible と Argo CD で管理する

初回の OS・GPU・K3s・Argo CD は Ansible、アプリの配置と更新は Argo CD に分担する。
Argo CD は研究室内の K3s に置き、GitHub に外向きに接続して設定を取得する。
GitHub Actions から研究室への SSH、Webhook の受信口、外部公開した管理画面は必要ない。

この構成の実装・ローカル検証は進行中で、新規 Ubuntu と RTX 4090 での通し受け入れ試験は未完了。
既存のインストーラーによる導入済み環境を無条件に引き継ぐものではない。

## リポジトリの分担

| 保存先 | 内容 |
|---|---|
| 公開 `videoq-jp/videoq` | アプリ、Helm、Ansible、配布・検証コード |
| 非公開の構成リポジトリ | ホストごとの採用バージョン、LAN向け設定、Argo CD Application |
| ホスト内 `/var/lib/videoq-bootstrap` | 初期認証情報の復旧用コピー（rootのみ読取） |
| Ansible Vault | 必要な場合の構成リポジトリの読取専用 deploy key |

構成リポジトリの初期名は `videoq-jp/videoq-lab-config` を想定するが、コードには固定しない。
研究室の Organization があれば、そちらで所有してもよい。将来のサービスは `clusters/lab/apps/` に
別 Application として追加し、必要な namespace と AppProject の権限を管理者が明示的に追加する。
動画、DB、パスワード、秘密鍵は構成リポジトリにも入れない。

## 1. 検証済みリリースから構成変更を作る

管理者の PC で Python 3.12 以降、Git、Helm を用意する。専用 venv を使う。

```bash
python3 -m venv /secure/videoq-operator
/secure/videoq-operator/bin/pip install -r infra/ansible/requirements.txt
```

公開された成功済み On-prem Release の `source-sha`、`run-id`、`run-attempt` を選び、
そのソースを取得する。`main` の最新コミットが公開済みリリースとは限らない。
既存の公開配布物の取得・署名検証を使う。

```bash
VIDEOQ_VERIFY_PYTHON=/secure/videoq-operator/bin/python \
  /secure/videoq-operator/bin/python scripts/onprem/public_release.py \
  --source-sha SOURCE_SHA --run-id RUN_ID --run-attempt 1 \
  --directory /secure/videoq-release

/secure/videoq-operator/bin/python scripts/gitops/promote.py \
  --release-directory /secure/videoq-release \
  --source-sha SOURCE_SHA --run-id RUN_ID --run-attempt 1 \
  --repository https://github.com/videoq-jp/videoq-lab-config.git \
  --public-url https://192.168.1.50 --listen-ip 192.168.1.50 \
  --storage-gib 40 --output /secure/videoq-lab-config
```

`SOURCE_SHA` と `RUN_ID` は実際の配布物の値に置き換える。コンパイラは現在の配布スキーマを検査し、
main の成功実行、Sigstore 署名・透明性ログ、ソース、チャートと各イメージの digest を検証する。
インフラ設定を生成するソースファイルも対象リリースと一致させる。検証に失敗した場合は出力しない。
サーバーでのビルドや、その場での未固定 `helm dependency update` は行わない。

生成結果は構成リポジトリで PR にして確認する。このコマンドは push・デプロイを行わない。

```text
clusters/lab/
  apps/gpu.json          # GPU plugin の Application
  apps/videoq.json       # VideoQ 一式の Application
  gpu/resources.json    # digest 固定の NVIDIA plugin と3共有スロット設定
  videoq/resources.json # DB、ストレージ、キュー、推論、アプリ
  release-lock.json     # 検証した配布元と生成ファイルのハッシュ
```

構成リポジトリの default branch を PR 経由の変更に制限する。Argo CD はこのリポジトリを
管理者の信頼済み設定として扱う。署名検証は構成への昇格時に行い、Argo CD が独自に
すべてのコンテナの Sigstore 署名を検査するという意味ではない。

## 2. Ansible で初回準備する

Ubuntu 22.04/24.04 amd64、RTX 4090 1枚、十分な空きディスクを持つ専用ホストを用意する。
LAN IP、DNS/DHCP予約、SSHホスト鍵、sudo権限は管理者が事前に確認する。

```bash
cd infra/ansible
cp inventory.example.yml inventory.local.yml
# inventory.local.yml の SSH 接続先、LAN URL、構成リポジトリを編集
/secure/videoq-operator/bin/ansible-playbook -i inventory.local.yml site.yml --ask-become-pass
```

正常な NVIDIA ドライバーがある場合は保持し、580.65.06 以降か検査する。
未導入なら inventory に `videoq_install_driver: true` と `videoq_allow_reboot: true` を指定する。
Ubuntu のドライバーパッケージを導入して1回再起動し、再接続する。既に導入済みなのに GPU が
利用できない場合は再起動を繰り返さず停止する。

K3s・Argo CD の上流ファイルは `pins.json` のバージョン・SHA-256で固定する。
Argo CD と NVIDIA plugin の実行イメージも Linux amd64 の digest に固定する。
NVIDIA Container Toolkit は署名検証される公式 APT リポジトリから指定バージョンを取得する。
K3s の kubeconfig は root 専用とし、Traefik と ServiceLB は初期導入しない。
Argo CD の API、DB、ストレージ、推論サービスは ClusterIP のままにする。
VideoQ の HTTPS だけを指定したホストの LAN IPv4 と443番に割り当てる。

非公開構成リポジトリには読取専用 deploy key を登録し、Git URL を
リポジトリ画面の **Code → SSH** からコピーした URL にする。
秘密鍵は `videoq_gitops_ssh_private_key` を定義した Ansible Vault ファイルから渡す。

```bash
ansible-vault create vault.local.yml
ansible-playbook site.yml -e @vault.local.yml --ask-vault-pass --ask-become-pass
```

秘密値を引数の `-e key=...` や平文の inventory に書かない。登録先は Argo CD の repository Secret。
GitHub のホスト鍵検証は維持する。GHCR の公開アプリイメージに GitHub ログインは不要。

## 3. 管理者が同期する

管理画面は必要時だけ開く。管理者の PC から SSH トンネルを作り、ホスト側の
`kubectl port-forward` は loopback のみに bind する。

```bash
# サーバー上（SSH接続中の別端末で保持）
sudo k3s kubectl -n argocd port-forward svc/argocd-server 8080:443 --address 127.0.0.1

# 管理者のPC
ssh -N -L 8080:127.0.0.1:8080 ubuntu@192.168.1.50
```

`https://localhost:8080` を開く。初期管理者パスワードはサーバー上で
`sudo k3s kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d`
から確認し、ログへ転記せず初回ログイン後に変更する。

1. `lab` を同期し、子 Application を登録する。
2. `lab-gpu` を同期し、`nvidia.com/gpu.shared` が3スロットになることを確認する。
3. `lab-videoq` の差分を確認して同期する。

初期状態では全 Application の自動同期と自動 prune を無効にする。
DB・永続領域（wave 0）→モデルとストレージ初期化（wave 10）→DB migration（wave 20）
→API/Web/worker（wave 30）の順に同期する。Helm の pre-install migration はそのまま使うと
初回DB作成より先に実行されるため、明示的な Argo CD Sync hook に変換している。
モデル内の起動順序は既存の Embedding → Whisper → Chat を維持する。

VideoQ 管理者の初回作成と LAN 内 HTTPS の CA 配布は別途行う。
既存の `scripts/onprem/rtx4090.py` をこの構成に重ねて実行しない。
ブラウザの管理者設定、動画投入→文字起こし→索引→引用付き回答、バックアップと復旧の
受け入れ試験が完了するまでは、運用開始済みとは扱わない。

## 更新・保存データ・既存環境

更新は新しい検証済み Release から構成変更を生成し、PR で採用する。
同期前に動画処理が完了していることを確認し、DB・動画・モデル設定・秘密情報をバックアップする。
Argo CD の同期は自動バックアップや、DB migration の取り消しを実装するものではない。
通常のアプリ更新と、モデル変更・再索引・OS/GPUドライバー更新を区別する。

PVC は `Prune=false,Delete=false` とし、Application に削除 finalizer を付けない。
これは誤削除を減らす設定であり、物理ディスク故障へのバックアップの代わりにはならない。
初期認証情報は生成後に保持し、再実行では変更しない。既存 Secret とホスト側コピーが
食い違う場合や、コピーなしで既存 Secret が見つかった場合は上書きせず停止する。

既存 K3s は `videoq_adopt_existing_cluster: true` で明示的に選択できるが、サービス定義や
K3s設定は置き換えない。旧インストーラーの認証情報・Helm所有権・更新タイマーの引き継ぎは
自動化していない。バックアップと所有権の移行を確認してから Argo CD に管理を渡す。

配布物の削除は「最新2世代」に加えて、構成リポジトリで現在採用中の digest も保護する必要がある。
非公開構成リポジトリを既存の retention 処理へ登録する連携は未実装のため、実運用を開始する前に
組み込む。構成だけ過去へ戻しても、DB復元や削除済みイメージの再取得ができるとは限らない。

Vast.ai の検証ホストは、GPUの実機試験中だけ起動し、CI待ち・実装中・試験終了後は停止する。
停止中のディスク保持料金は別に残る。

## 検証

```bash
cd infra/ansible
ansible-playbook -i inventory.example.yml site.yml --syntax-check
cd ../..
python -m unittest discover -s scripts/gitops -p 'test_*.py' -v
```

テストは実 Helm チャートのローカルレンダリング、DB hook の順序、保存領域の削除保護、
プライベートな Service、digest 固定、秘密情報の再利用と衝突時の書込拒否を検査する。
`--check` は GPU・Kubernetes・ネットワークの準備完了を証明できないため、現 playbook では受け付けない。

公式資料:
- [Ansible get_url の checksum](https://docs.ansible.com/projects/ansible-core/2.21/collections/ansible/builtin/get_url_module.html)
- [K3s 設定](https://docs.k3s.io/installation/configuration)
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
- [Argo CD 宣言的セットアップ](https://argo-cd.readthedocs.io/en/stable/operator-manual/declarative-setup/)
- [Argo CD Sync phases / waves](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/)
