# 研究室内GitからVideoQの正式リリースへ自動追従する

目標は更新PRの通知だけではなく、成功した正式リリースの検出から配置・動作確認までを研究室側で
実行すること。`main` の各コミット、失敗したCI、draft、prereleaseには追従しない。
設定の保存先は研究室内のForgejo/GitLabでよく、外部から研究室へのSSHやWebhookは不要。
公開VideoQリリース・イメージ・モデルの取得には外向きの接続を使う。完全オフラインの更新ではない。

初回のAnsible、管理者設定、HTTPSの信頼、GPU/API/UIの受け入れは
[導入手順](lab-gitops.md)を使う。その後、ホストのsystemd timerが15分間隔（最大1分の分散）で
`scripts/gitops/update.py` を実行する。初回受け入れを記録するまでタイマーは更新を開始しない。

## 更新の順序

1. 現在のGit版、クラスタの識別情報、10 Deployment、Argo CDの同期・正常状態、HTTPS `/ready`、
   正常状態を確認する。実アプリのsmoke testは初回受け入れと更新後に実行し、更新のない定期確認では動画を増やさない。
2. GitHubの公開カタログから新しい正式リリースを選び、mainの成功実行、Sigstore署名、透明性ログ、
   配布物のSHAとイメージdigestを既存の検証器で検査する。通信・検証に失敗したら稼働環境を変更しない。
3. 固定したレビュー済みコンパイラで、検証したソースSHAと必要な生成レシピが一致することを確認して構成を生成する。LAN IP・保存容量・Git接続先はホストの設定を使う。
   モデルの生成レシピ、GPU plugin、ブートストラップの固定値が変わる版は、保守作業での受け入れが必要として停止する。取得した新版のPythonスクリプトをrootで実行することはない。
4. 新版のイメージを先に取得する。自前4パッケージのイメージはホスト内にもアーカイブし、K3sの
   `agent/images` へ配置する。公開側の最新2世代整理後も、採用したイメージの再取り込みに使える。
5. 書き込みアプリ、保守CronJob、DB・S3・キューを停止し、DB・S3・キュー・内部CAの4領域と
   認証情報のcold backupを取得・ハッシュ検査する。短時間の利用停止が発生する。
6. 研究室内のGitへ新構成を通常のfast-forward pushで記録する。競合時にforce pushはしない。
7. Argo CDへそのコミットSHAの同期を要求し、migrationと各アプリの起動を待つ。自動pruneはしない。
8. 正常状態、HTTPS `/ready`、実アプリのsmoke testが通ったら採用済み状態とバックアップ先を記録する。

Argo CDの`automated`/`selfHeal`は無効のままにする。Gitが変わった瞬間に配置する方式では、
バックアップより先にmigrationが始まるため。自動化の主体はホスト側の更新サービスであり、
管理者が毎回Syncを押す必要はない。初回だけ管理者が受け入れを記録する。

## 接続・初回有効化

Forgejoで設定リポジトリを作り、初期構成を登録する。Forgejo自体の初回導入はこの更新サービスの
担当外で、Ansibleから独立して復旧できるようにする。専用SSH deploy keyを2本用意する。
Argo CDはread-only、更新サービスは当該リポジトリだけwrite可能にする。両者で鍵を共用しない。
SSHホスト鍵を管理者が確認し、Vaultに秘密鍵を保存する。HTTPSの資格情報入りURLは使わない。
コンパイラは`ssh://git@forgejo.lab:2222/lab/config.git`などを受け付ける。

inventoryへ以下を追加し、Ansibleを実行する。`videoq_update_source_revision`はこの実装を含む
レビュー済みコミットの完全なSHAへ置き換える。更新器自身を無条件にmainへ更新しない。

```yaml
videoq_gitops_repository: ssh://git@forgejo.lab:2222/lab/config.git
videoq_update_enabled: true
videoq_update_source_revision: REVIEWED_FULL_40_CHARACTER_SHA
videoq_update_site: lab
videoq_update_listen_ip: 192.168.1.50
videoq_update_storage_gib: 40
videoq_update_ca_file: /etc/videoq-bootstrap/lab-ca.crt
videoq_update_health_command: [/usr/local/lib/videoq-lab/smoke-test]
```

Vaultで `videoq_gitops_ssh_private_key`（Argo用）、`videoq_update_git_ssh_private_key`（更新用）、
`videoq_gitops_known_hosts`（検証済みホスト鍵）を渡す。smoke testは管理者所有の実行ファイルとし、
専用検証アカウントで文字起こし・索引・引用付き回答などを検査して、失敗時は非0で終了するようにする。
テストの認証情報はroot専用ファイルから取得し、Gitやログへ保存しない。
内部CA公開証明書を`videoq_update_ca_file`へ配置する。証明書検証は無効化しない。

初回の配置と実モデル・画面操作の受け入れ後、サーバー上で実行する。

```bash
sudo systemctl start videoq-update-initialize.service
sudo systemctl start videoq-update.service
sudo systemctl list-timers videoq-update.timer
sudo journalctl -u videoq-update.service
```

初期化は採用中のGitコミットとクラスタの識別情報を`/var/lib/videoq-updater/state.json`へ記録する。
既に記録済みなら上書きしない。初回構築・初回管理者設定自体は自動更新とは別の一度だけの作業になる。
SSH鍵、kubeconfig、smoke testの資格情報、認証情報バックアップはいずれもGitへpushしない。

## 失敗・保存領域・復旧

同時更新はファイルロックで防ぐ。Gitの手動変更、別のArgo操作、異なるクラスタ、未完了の更新を
検知したら、次のリリースへ進めない。新構成を公開する前の失敗では旧アプリを再開する。
公開・同期開始後の失敗ではArgoの操作終了を確認して書き込みを停止し、履歴・旧イメージ・
バックアップ・未完了journalを保持する。DB migration後に古いイメージだけを戻す処理は行わない。
エラーはsystemdの失敗状態とjournalに残る。メール・チャット通知先は別途運用側で接続する。

復旧時はtimerを止め、実行中のArgo同期と`state.json`の`pending_update`を調べる。
通常のGit revertだけでDBを戻したことにしない。受け入れ済みバックアップと元のPVC/クラスタの識別情報を
検査し、4領域・認証情報・以前のGit構成を整合させて復旧し、実アプリ試験を通してから再開する。
この版では未完了journalの自動解除や自動ロールバックは行わない。

更新バックアップは`/var/lib/videoq-updater/release-*/snapshot`へroot専用で保存する。
このcold backup自体は平文の認証情報を含むため、暗号化ストレージ上で管理し、別ホストへ持ち出す場合は
別管理の鍵で暗号化する。Gitサーバーとアプリデータのオフホストバックアップは別途必要。
更新器はバックアップや旧イメージを自動削除しないため、保存容量を監視して保管期限を管理する。
空き容量不足によるイメージ取得・バックアップ失敗時は、新版の同期へ進まない。

アプリ更新は自動追従するが、OS・GPUドライバー・K3s・Argo CD・GPU pluginの保守は分ける。
この変更の単体試験は外部API/クラスタを置き換えた制御フロー試験を含む。Forgejoと実Argo CDを組み合わせた
連続更新・失敗復旧の実機受け入れを省略して「運用済み」と扱わない。

参考: [K3sのイメージ取り込み](https://docs.k3s.io/add-ons/import-images)、
[Argo CDの自動同期](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/)。
