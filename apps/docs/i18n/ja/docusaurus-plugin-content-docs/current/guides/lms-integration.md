---
title: LTI 1.3 で LMS と連携する
description: VideoQ の任意の LTI 機能を有効化し、別リポジトリの Moodle プラグインを接続する。
---

# LTI 1.3 で LMS と連携する

VideoQ は LTI 1.3 による受講者の認証と、講座の教材を対象にした AI 回答を担当します。
Moodle は履修登録、元の動画ファイル、動画再生を担当します。2つの Moodle プラグイン、
配布 ZIP、導入手順、検証環境は別の
[videoq-moodle](https://github.com/yukiharada1228/videoq-moodle) で管理します。
通常の VideoQ ビルドにこのリポジトリは不要です。`LTI_CONFIG` が未設定なら、
連携 API と接続設定画面は利用できません。

## VideoQ 側の準備

1. 通常の CI/CD と DB 移行の手順で反映します。`0046_lti_materials` は、
   `0045_course_qa` までの通常の `main` に LTI 認証情報、接続、講座、教材対応表を追加します。
   既存の動画・講座・利用者のデータは変更しません。未公開の試用環境とは移行履歴が異なるため、
   試用 DB に対するアップグレード手順として実行しないでください。
2. 既存の S3 互換署名付きアップロード、動画処理 worker・queue、保守スケジューラを維持します。
   新規の Moodle 接続では、LTI の署名付きサービス認証で教材の発見・権限確認・転送・状態確認を行います。
3. チェックアウト外の安全な場所に、連携用の署名鍵を生成します。

   ```sh
   node apps/api/scripts/generate-lti-tool-keys.mjs /secure/lti-tool-keys.json
   ```

   このスクリプトは既存ファイルを上書きせず、権限 0600 のファイルを作成します。
   内容を API の `LTI_TOOL_KEYS` シークレットとして設定し、チャット・Git・ログには出さないでください。
   リリースごとに鍵を作り直す必要はありません。鍵の切り替え中は、旧鍵の**公開部分のみ**を
   `previous` に保持します。
4. `LTI_CONFIG` に公開 HTTPS API のオリジンを設定します。videoq.jp の場合は次の値です。

   ```json
   { "toolOrigin": "https://videoq.jp", "databaseRegistrations": true, "registrations": [] }
   ```

   Cloudflare では、コードと DB 移行の確認後、秘密ファイルから読み込みます。

   ```sh
   npx wrangler secret put LTI_CONFIG --config apps/api/wrangler.jsonc --env production < /secure/lti-config.json
   npx wrangler secret put LTI_TOOL_KEYS --config apps/api/wrangler.jsonc --env production < /secure/lti-tool-keys.json
   ```

   Node 構成では同じ2つの設定を通常のシークレット管理から渡します。
   本番に試用環境の鍵や DB を流用しないでください。
5. `GET /api/lti/jwks` が、秘密部分を含まない RSA 公開鍵を返すことを確認します。
   起動パラメータのない LTI ログイン URL は拒否されます。URL を直接開くだけでは連携の確認になりません。

## Moodle を接続する

1. [Moodle の導入手順](https://github.com/yukiharada1228/videoq-moodle/blob/main/docs/setup.md)に従い、両方のプラグインを入れます。
2. 所有者の VideoQ アカウントの**設定 → Moodle と接続**で Moodle の正確な HTTPS ベース URL を入力します。
   発行した `VIDEOQ2.` コードを10分以内に Moodle の **VideoQ に接続**画面に貼り付けます。
   通常の設定に接続専用の同期 API キーや動画ごとの JSON は不要です。
3. Moodle のファイル活動で **VideoQ の質問機能**を有効にし、cron を動かして転送・文字起こし・検索準備の完了を待ちます。
4. 受講者として講座の質問画面を開き、実際の回答の逐次表示、引用、動画切り替え、Good/Bad の切り替え・解除を確認します。
   履修していない利用者からは教材を利用できないことも確認します。
5. 自分の試験教材を差し替え・削除し、対応する VideoQ のコピーだけが更新され、無関係な動画や個人の質問履歴が保たれることを確認します。

元の動画は Moodle が保存・再生し、処理用コピーは VideoQ が保存します。
質問ごとに Moodle の現在の権限を確認します。教材同期そのものは LTI 標準の機能ではありません。
LTI の認証を使い、教材の転送・照合は VideoQ/Moodle 間の独自サービス契約で実現します。

## 接続解除と確認範囲

所有者は VideoQ の設定から接続を解除できます。以後の起動・質問・同期を拒否し、既存の学習データは保持します。
Moodle 側の信頼設定も無効にする場合は、Moodle 標準の外部ツール管理から VideoQ を無効化・削除します。
応答の失敗や欠落を、すべての動画を削除する指示として扱うことはありません。

手動の静的 LTI 登録や旧方式の push API は運用者向けです。同じ issuer/client を静的設定と DB の両方に登録しないでください。
Deep Linking、成績返却、名簿同期は対象外です。公開鍵エンドポイントはサービス認証を支えますが、LTI 認証取得や全 LMS との互換性を意味しません。

本番で有効化する前に、導入先の Moodle・テーマ・ブラウザで確認してください。
[試用環境の検証記録](https://github.com/yukiharada1228/videoq-moodle/blob/v0.10.1/docs/integration-review.md)では、
別サイトでのチャット起動、100人分の動画全編配信、AI 回答の途中終了が未解決です。
単体テストや CI の成功だけで、これらの解消や本番の処理能力・回答速度を保証するものではありません。
