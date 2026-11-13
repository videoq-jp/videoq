---
title: Moodle・その他のLMSと接続する
description: Moodleプラグインを1つ導入し、先生ごとに自分が所有するVideoQ講座を接続する。
---

# Moodle・その他のLMSと接続する

Moodleは履修登録・現在の講座権限・学習画面を担当し、VideoQは接続した講座の動画保存・処理・AI回答を担当します。Moodle連携は別の[videoq-moodle](https://github.com/videoq-jp/videoq-moodle)で管理し、通常のVideoQビルドには不要です。

Google Classroomは別の[Classroomアドオン](google-classroom-integration.md)で接続します。

## Moodle を接続する

1. 現在のクラウド版 `https://videoq.jp` または対応するHTTPSの自前VideoQを使います。自前環境は先生ごとの接続APIとDBマイグレーション0062〜0064が必要です。既存の `BETTER_AUTH_URL`、`USER_SECRET_ENCRYPTION_KEY`、S3互換ストレージの設定を維持し、通常のデプロイ・DB移行手順で更新します。クラウド版では利用者がサーバーの秘密情報を設定する必要はありません。
2. Moodleの「プラグインをインストール」で **local_videoq.zipを1つだけ**導入します。0.25.4で旧補助プラグインへの依存を削除しました。[配布ページ](https://github.com/videoq-jp/videoq-moodle/releases/tag/v0.25.4)からZIPと確認用のSHA256SUMSを取得し、[日本語の導入手順](https://github.com/videoq-jp/videoq-moodle/blob/main/docs/setup.ja.md)に従ってください。Gitは運用者向けの任意の方法です。プラグインはプレリリースで、Moodle公式ディレクトリの審査は未完了です。
3. Moodle管理者が「VideoQに接続」を開き、接続するサービスを選びます。VideoQでログインして学校との通信を許可し、Moodleに戻って完了します。この操作は通信の許可であり、管理者が全講座を所有したり、管理者の利用枠を共有したりする設定ではありません。
4. 各講座の編集権限を持つ先生が「自分のVideoQアカウントを接続」を選び、自分のアカウントでログインして、自分が所有する既存のVideoQ講座を選択します。Moodle講座ごとに接続責任者とVideoQ講座が決まり、他の共同教師が勝手に上書きすることはできません。
5. 動画の追加・編集はVideoQで行います。生徒はMoodleの講座アシスタントを開きます。生徒のVideoQアカウント登録と、Moodleのファイル活動からの動画取り込みは不要です。対象のMoodle・テーマ・ブラウザで再生、AI質問、引用、動画切り替え、講座Q&A、評価を確認してください。

学習画面はVideoQ本体の構成に合わせ、Moodleのテンプレート・テーマで表示します。会話は自動継続します。接続した講座所有者の先生だけが最新100件の質問履歴と、質問者情報を含む全件CSVを利用できます。生徒や他の共同教師には公開せず、保護された操作ごとに現在のMoodle権限を確認します。

## 既存環境の更新

自前VideoQでは先に本体を更新します。Moodleでは **local_videoqを削除せず、新しいZIPで更新**してください。Moodleの講座や動画を削除する必要はありません。旧 `ltisource_videoq` が残っていても更新できます。学習画面を確認した後、Moodleのプラグイン概要から旧補助だけをアンインストールし、Moodleがコードを削除できない場合に限り運用者がそのディレクトリを削除します。

自動生成済みのVideoQ活動リンクも、Moodle内の講座アシスタントへ移動します。別のLTI補助プラグインを導入したり、手動のLTI起動アクティビティを作ったりする必要はありません。[更新手順](https://github.com/videoq-jp/videoq-moodle/blob/main/docs/setup.ja.md)を参照してください。

旧一括所有・取り込み方式は廃止しました。管理者の所有権を自動で引き継がず、先生ごとにアカウントと既存講座を接続します。通常の更新では元の動画や過去の記録を保持します。

## 通信と署名鍵

選択したVideoQとMoodleが、必要なHTTPSエンドポイントへ到達できる構成にします。SSHのポート転送だけでは、外部のVideoQからローカルのMoodleを利用できるようにはなりません。APIを別ホスト名で公開する場合はその公開オリジンを入力し、そこから設定済みのフロントエンドへ案内します。独自のHTTPSポートにも対応します。

戻り先は開始元Moodleのプラグインに固定します。管理者のセッション、state、S256の確認情報で一時認可コードを保護するため、コードだけでは接続できません。

内部ではMoodle標準のツール登録と署名付きサーバー要求を使います。VideoQの署名情報は既存の連携テーブルで暗号化して保持します。更新時にアプリの暗号化キーを作り直さず、DB復元時にも対応するキーを使ってください。保存済みの鍵を読めない場合は、新しい鍵へ勝手に置き換えず拒否します。通常の導入で `LTI_CONFIG` や `LTI_TOOL_KEYS` を手動登録する必要はありません。

先生はVideoQの接続済みアプリ設定から個別の講座接続を解除し、学校の管理者は学校の通信許可を別に管理します。解除後は保護された操作を拒否し、保存済みの学習データは保持します。解除と個人データの削除要求は別の操作です。成績返却、名簿同期、一般的なLTI認証取得は対象外です。

## その他のLMS向けコネクター

Moodleの自動接続はMoodle専用です。他のLMSには、そのLMS自身のissuer・HTTPSのJWKS/OAuth/現在の権限確認エンドポイントを持つコネクターが必要です。LMSの認証済みセッションから利用者と現在の所属・権限を導出して署名し、VideoQのネイティブ学習・プライバシー・教材サービスの契約を実装します。通常のLTI起動だけでは、この独自の契約を実装したことにはなりません。他のLMSのissuerや署名鍵を流用しないでください。

運用者は `apps/api/scripts/provision-lms.ts register-service INPUT.json NEW_OUTPUT.json` と、その環境の `DATABASE_URL` を使ってサービス接続を登録できます。入力は `id`、`ownerUserId`、`name`、`issuer`、`clientId`、`deploymentId`、`authorizationUrl`、`jwksUrl`、`materialsService: { tokenEndpoint, endpoint }` です。認可・JWKSのURLは登録したissuerのオリジンに属する必要があります。エンドポイントを承認するのは運用者で、生徒の要求から選択することはできません。出力は0600で新規作成し、サービス接続IDを返します。通信の許可に加えて、先生ごとの明示的な講座接続が必要です。

コンテキストAPIは `features/lms/connector-client.ts` と `contracts.ts` の `courses`、`manifest`、`access`、`export`、`status`、`ack` を実装します。IDはMoodleの数値IDに限定せず、不透明な文字列です。権限はVideoQ側の所有者・講座・教材・世代との対応と照合します。学習とプライバシー要求では同じ利用者識別子を保持し、個人データの出力・削除には別途承認されたLMS側の復旧権限が必要です。生徒権限で許可してはいけません。[共有コネクターの契約](https://github.com/videoq-jp/videoq/blob/241bd96b81aaf2b5b77de007d7246732433331d4/docs/design/moodle-native-ui.md#shared-connector-boundary)も参照してください。

## 検証範囲

Moodle 5.1.8+／Boost、PostgreSQL・MySQLで、0.25.3からの更新、旧補助の削除、1プラグインだけの新規インストールを確認しています。別の実インストール環境でも、学校の通信許可、先生の講座接続、生徒の動画再生・ローカル実AI回答、会話・評価の復元、所有者だけのCSV取得を確認しました。[プラグインの検証記録](https://github.com/videoq-jp/videoq-moodle/blob/main/docs/verification.md)を参照してください。

すべての学校の同時接続数、iPhone実機、すべてのLMSとの互換性を保証する検証ではありません。他のLMSには、それぞれの実装と受け入れ確認が必要です。
