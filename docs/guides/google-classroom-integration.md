---
title: Google Classroom アドオンとの連携
description: Google認証、教材の添付、生徒の動画・字幕・AI学習画面の設定と検証。
---

# Google Classroom アドオンとの連携

Google Classroomには、LTIとは別のClassroomアドオンとして接続します。
教師は課題・お知らせ・資料を編集するときにVideoQを選び、既存のVideoQ教材を添付できます。
生徒はClassroom内で動画を再生し、字幕・引用位置への移動・AIチャット・自分のAI会話・講座Q&Aを利用できます。
教師には講座Q&Aのモデレーション権限もあります。Googleが返す役割を利用し、URLの名前から教師権限を付与しません。

この連携はVideoQに登録済みの教材を使う**コンテンツ型アドオン**です。
Classroomへの成績返却、提出物の採点画面、Driveからの自動取り込み、名簿同期、リンクの自動アップグレードは含みません。
Classroomで教材を添付しても、VideoQへの動画アップロード・処理は別途必要です。
MoodleプラグインやLTI登録は必要ありません。

## Google側の設定

Google公式の[プロジェクト設定](https://developers.google.com/workspace/classroom/add-ons/developer-guides/project-configuration)
と[開発手順](https://developers.google.com/workspace/classroom/add-ons/get-started/developer-journey)に従い、
Google Cloudプロジェクトを作成します。Classroom APIとGoogle Workspace Marketplace SDKを有効化し、
OAuth同意画面とWebアプリケーションのOAuthクライアントを設定します。
アドオンとOAuthクライアントは同一プロジェクトに作成してください。
通常のVideoQ Googleログインとは別に、アドオン専用クライアントを設定できます。

APIの公開オリジンを `https://api.example.com` とした場合の登録値は次のとおりです。

| 項目 | 値 |
| --- | --- |
| OAuthリダイレクトURI | `https://api.example.com/api/classroom/oauth/callback` |
| Attachment Setup URI | `https://api.example.com/api/classroom/discovery` |
| Allowed Attachment URI Prefixes | `https://api.example.com/api/classroom/teacher` と `https://api.example.com/api/classroom/student` |
| OAuthスコープ | `openid`、`https://www.googleapis.com/auth/userinfo.email`、`https://www.googleapis.com/auth/userinfo.profile`、`https://www.googleapis.com/auth/classroom.addons.teacher`、`https://www.googleapis.com/auth/classroom.addons.student` |

教師の起動ではteacherスコープ、生徒の起動ではstudentスコープを要求します。
email・profileスコープで取得した確認済みメールアドレスと表示名を、作者向けの質問履歴・CSVに使用します。
認証の識別子にはGoogleの`sub`を使用します。
取得するクレームは[GoogleのOpenID Connect仕様](https://developers.google.com/identity/openid-connect/openid-connect#an-id-tokens-payload)に従います。
署名を検証したGoogle IDトークンの `sub` を利用者識別に使用します。

開発用の非公開アドオンには、対応するGoogle Workspace for Educationのテストドメイン・ライセンスと
教師／生徒のテストアカウントを用意します。必要なライセンスや許可の取得は
[Googleの前提条件](https://developers.google.com/workspace/classroom/guides/onboarding/prerequisites)を確認してください。
一般公開にはOAuthスコープの検証とMarketplace審査が必要です。コードのデプロイだけではMarketplaceに掲載されません。

## VideoQ側の設定

既存のDBマイグレーションを適用済みのAPIに次の環境変数を設定します。
Cloudflare Workersでは秘密情報をsecretとして登録し、Nodeでは実行環境のsecretから渡してください。
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` は通常のVideoQログイン用で、この機能では使用しません。

| 環境変数 | 内容 |
| --- | --- |
| `CLASSROOM_CLIENT_ID` | 上記OAuthクライアントのID |
| `CLASSROOM_CLIENT_SECRET` | 上記OAuthクライアントのシークレット |
| `CLASSROOM_CONFIG` | 下記の管理者設定JSON。未設定または `false` で無効 |
| `USER_SECRET_ENCRYPTION_KEY` | 既存の32バイトbase64url暗号化キー。既存環境では変更しない |

例:

```json
{"toolOrigin":"https://api.example.com"}
```

クラスと講座の対応は環境変数に書かず、先生が画面から接続します。
管理者は学校のアドオン利用を許可し、先生はClassroomの教材選択画面でGoogle認証後に
**自分のVideoQアカウントを接続**を押します。別ウィンドウでVideoQにログインし、
自分が所有する講座を選んで接続します。元の画面で**接続を確認**を押すと教材を添付できます。

1クラスにつき接続責任者とVideoQ講座を1つに固定します。共同教師も接続済み教材を利用できますが、
別の先生のアカウントや講座へ上書きできません。質問履歴・CSV・利用枠は講座所有者のものです。
異なるクラスのQ&Aを分離する場合は別のVideoQ講座を選んでください。
生徒にVideoQアカウントは不要です。Googleのクラス所属・役割を毎回検証します。
接続先アカウントが無効な場合は利用を拒否します。

旧形式の `CLASSROOM_CONFIG.courses` は削除しました。互換動作や暗黙の所有者引き継ぎはありません。

アップロード動画の再生には、既存のS3互換署名URL設定（`USE_S3_STORAGE=true`、R2/S3の認証情報・エンドポイント）を使います。
R2を使う場合もS3互換アクセスを設定してください。動画の署名URLは既存仕様で最大1時間有効です。
YouTube教材ではプライバシー強化モードの埋め込みを使用します。
動画の読み込みに失敗しても、字幕やAIチャットは利用できます。
YouTube再生位置のAI質問への自動送信は行いませんが、回答・字幕から指定位置を開けます。

先生ごとのクラス接続は `teaching_connections` に保存します。DBマイグレーション0062・0063を適用してください。
既存の `lti_credentials` に種類を分けて一時資格情報を保存します。
通常のメンテナンス処理が期限切れレコードを削除します。
設定変更は新しいリクエストから有効になり、既存の学習セッションも無効化します。
設定を更新した後はClassroomから教材を開き直してください。

## 利用の流れ

1. テストドメインでアドオンをインストールします。
2. 教師がClassroomの課題・お知らせ・資料を編集し、アドオンからVideoQを選びます。
3. **Google でログイン**を押し、ポップアップで同意します。初回は先生のVideoQアカウントと講座を接続します。
4. 教材を選択して**Classroom に添付**を押します。Google APIで添付が作成されてから選択画面が閉じます。
5. 生徒が添付教材を開き、自分のGoogleアカウントでログインします。動画とAI質問を利用できます。
6. 利用を終了するには**Google アカウントの接続を解除**を押します。

Googleの `login_hint` は認証のヒントとアカウント照合にのみ使用し、認証情報として扱いません。
再訪問ではブラウザ保存のランダムな資格情報と暗号化したrefresh tokenを用いて認証を再利用します。
保存情報がない・期限切れ・Google側で権限が取り消された場合はログインをやり直します。
iframeのCookieには依存せず、OAuthポップアップのコールバック検証にのみSecure / HttpOnly / SameSite=Lax Cookieを使います。

接続解除はVideoQに保存したGoogle資格情報を削除し、それを使う学習セッションも即時拒否します。
Googleアカウント自体の同意を取り消す操作はGoogle側のアカウント設定で行ってください。
Google APIの利用権限を削除しても、投稿済みQ&Aや個人の学習履歴は削除しません。
個人の会話は学習画面から削除できます。保存済み会話を削除すると、それに紐づく回答ログも削除されます。

### 作者による質問分析とCSV

Classroom経由の質問・回答も、本体の講座所有者向け履歴・CSV出力の対象です。
CSVには日時、質問、回答、引用元、評価、および質問者の識別ID・Googleの表示名・確認済みメールアドレスが含まれます。
氏名・メールアドレスは署名検証済みIDトークンから取得し、質問時の情報を保存します。
取得できない場合は同一生徒を区別する識別IDを使用し、メール欄は空欄にします。
従来の質問へ名前を後から補完することはありません。追加のprofileスコープには再同意が必要です。
閲覧・CSV出力は、本体でも連携画面でも講座所有者に紐づいた先生だけが利用できます。Classroomの教師権限だけでは利用できません。連携画面ではGoogleの現在の教師権限と、接続した先生のGoogle IDを毎回確認します。
他の生徒の個人会話を参照する権限は付与しません。

この変更の利用前にDBマイグレーション `0062_classroom_question_authors` を適用してください。

## Classroom内の画面デザイン

Classroom用の検出・ログイン・学習画面には、Material 3の色の役割とタイポグラフィのトークンを使用しています。
Classroomになじむ緑を主色に、白いサーフェス、控えめな境界線、丸みのあるボタン、48pxの入力欄、
44px以上の主要ボタンを組み合わせています。VideoQ本体の講座画面と同じ構成に揃えています。
PCでは左に動画と「概要／Q&A」、右に「動画一覧／AIアシスタント」を配置します。
スマートフォンでは動画の下に学習パネルを置き、「詳細」タブから概要などを開けます。
文字起こしを読むタブは表示せず、字幕データはAI回答と引用元へのジャンプに使用します。
動画を隠して会話領域を広げる操作にも対応しています。会話は本体と同じく自動で継続し、「新しい会話」や個人の会話履歴を管理する操作は表示しません。接続した先生には「チャット／講座の質問履歴」とCSV出力を表示し、履歴は本体と同じ最新100件、CSVは全件を対象とします。Moodle側の見た目はこのテーマの影響を受けません。

Reactは必要ありません。既存のHTML・ネイティブフォーム要素を保ち、
[Material Webの色トークン](https://github.com/material-components/material-web/blob/main/docs/theming/color.md)と
[文字のトークン](https://github.com/material-components/material-web/blob/main/docs/theming/typography.md)に沿って実装しています。
公式のMaterial Webコンポーネントは[メンテナンスモード](https://github.com/material-components/material-web/blob/main/docs/roadmap.md)のため、
今回そのランタイムやReactの依存は追加していません。
この画面はVideoQのClassroomアドオンであり、Google公式アプリを装うロゴやブランド表示は使用しません。

## 権限と保存

- 起動・学習操作ごとにGoogleの `getAddOnContext` と添付情報を取得し、コースの所属・役割と現在の添付教材を照合します。
- アドオン自身が作成した添付だけを許可します。起動URLの `material` を書き換えても権限は変わりません。
- Google側で添付を削除、所属を解除、またはAPIアクセスを拒否すると次の学習操作から拒否します。
- コピーされた添付は、コピー先クラスでも先生による接続が必要です。別クラスの接続や教材IDを自動的に引き継ぎません。
- Googleのaccess/refresh tokenと学習セッション内のアカウント資格情報は、用途と保存IDを結び付けたAES-GCMで暗号化します。
- Googleアカウントの接続資格情報は最大30日、学習セッションは1時間、OAuth stateは5分です。refresh tokenがない場合はaccess tokenの期限までです。
- APIへの認証情報はAuthorizationヘッダーで送信し、クエリ文字列や親のClassroom画面に渡しません。Googleのエラー本文もログに記録しません。
- Google認証は署名・発行元・audience・nonce・PKCE・state・コールバックCookieを検証します。stateは一度だけ使用できます。
- Classroom、MoodleのネイティブAPI、LTIのセッションは相互に認証情報として利用できません。

## 検証

自動テスト:

```sh
npm run typecheck --workspace @videoq/api
npm run test:unit --workspace @videoq/api -- test/classroom-routes.test.ts test/classroom-oauth.test.ts test/classroom-view.test.ts test/classroom-player.test.ts test/lti-routes.test.ts test/lti-protocol.test.ts test/moodle-native-api.test.ts
```

実際のGoogle環境では次の受け入れ確認が必要です。ローカルのモックテストでは代替できません。

1. 教師アカウントで3種類の投稿への教材添付を行い、添付が保存されて検出iframeが閉じること。
2. 異なる生徒2人で開き、個人AI会話を互いに参照できないこと。教師にも他者の個人AI会話を表示しないこと。
3. 動画・字幕・AIストリーム・引用位置・講座Q&Aと教師モデレーションを確認すること。
4. 再訪問とaccess token更新、アカウント切替、接続解除後の再ログインを確認すること。
5. 生徒のコース離脱、教材削除、添付削除、設定解除後にアクセスが拒否されること。
6. 別コースへの投稿コピーでは、未設定コースを拒否し、先生が接続したコピー先でも教材の再添付が必要になることを確認すること。
7. サードパーティCookieを制限したブラウザでも、許可したログインポップアップから認証できること。

公開前には[Googleのアドオン要件](https://developers.google.com/workspace/classroom/add-ons/requirements)
と[審査手順](https://developers.google.com/workspace/classroom/add-ons/developer-guides/review-process-overview)に沿って実環境を検証してください。
