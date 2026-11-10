# クラウド版の規約・データ処理確認

初回確認日: 2026-11-10。追補: 2026-11-11。対象は `https://videoq.jp` の日英の利用規約、
プライバシーポリシー、返金・解約ポリシー、特商法表記。
オンプレミス版の個別構成・契約へ、この結論をそのまま適用しない。

## 確認した事実

| 項目 | 証拠・結果 |
| --- | --- |
| 公開ページ | 本番 `/privacy` の本文に現在の Cloudflare / Neon / AWS / OpenRouter / SearchAPI / Google / Mailgun / Stripe の説明がある。今回の修正文はまだ本番反映していない。 |
| 料金 | 本番公開 `billing.plans` を ja/en で取得。Basic は JPY 1,480/月・14,800/年、USD 9.99/月・99.90/年。Pro は JPY 3,980/月・39,800/年、USD 26.99/月・269.90/年。文字起こし枠は45/200/1,000分。 |
| Stripe Portal | 本番デフォルト設定で解約が有効・期間末解約、プラン変更が有効・日割り即時請求。低額プラン・短い周期への変更も「今すぐ更新」。Basic/Pro の月額・年額4価格を登録済み。設定の保存・契約変更・決済は行っていない。 |
| Stripe 公開情報 | サポートメール、terms/privacy/legal のURLがサイトの記載と一致。本人の住所・電話・生年月日などはこの記録に転記しない。 |
| Stripe Checkout設定 | 規約・プライバシーリンクと返金表示が有効。返金URLは `/refund`。返金補足文を `support@videoq.jp` に修正・保存し、再読み込み後も一致を確認。今回のAPI変更はセッションごとに `consent_collection.terms_of_service=required` を指定する。API変更は未公開で、実画面の確認が残る。 |
| 運用窓口 | 運営者が、support@videoq.jp の受信・返信と、購入前の住所・電話の開示請求への対応が可能と本セッションで確認。 |
| 本番動画処理 | AWS `videoq-worker-prod` の公開可能な環境設定だけを取得。OpenRouter 接続、Whisper backend=openrouter、embedding=text-embedding-3-small、visual=true。東京リージョン。 |
| 削除 | API はアカウントを無効化し、永続タスクで Stripe 顧客削除後にデータ削除を配送。失敗は再試行。Python worker は動画・派生画像・ベクトル・チャット等を削除してからユーザー行を削除。会話チェックポイントには会話行への削除連鎖を設定。 |
| バックアップ検証 | `.github/scripts/backup-restore.mjs` は本番DBを読み取り、隔離DBで復元検証し、finally で一時dumpとコンテナを削除。これは長期バックアップの存在や、Neon PITR/R2復元の検証を意味しない。 |
| 現行 AWS ログ | AWS API の実値で worker/media/search/account は30日、DB起動系は14日。設定ファイルの既定値だけで判定していない。 |
| 旧 AWS ログ | 削除済み旧APIのロググループ `/aws/lambda/videoq-api-prod` は当初保持期限なし、保存量7,145,011 bytes。最終イベントは2026-08-03 UTC。運営者の承認後、2026-11-10 14:48 UTC に30日保持へ変更し、AWS APIで `retentionInDays=30` を再取得して確認。既存ログは削除対象だが、再取得時点の保存量は同じであり、削除完了とは報告しない。 |
| OpenRouter アカウント設定 | 有料endpointの学習利用=off、無料endpointの学習利用=on、無料prompt公開=off、1%データ割引=off。ZDR制限はoff。現在のクラウド構成は有料モデル。アカウント全体の設定を確認したもので、個々の本番リクエストのルーティング履歴を監査したものではない。 |

## 文面に反映した内容

- 通常の期間末解約とアカウント削除を区別し、データ削除は別途依頼することを明示。
- 決済通知から利用枠反映まで数秒かかる実装に合わせ、「ただちに付与」の断定を修正。
- 即時ダウングレードと日割りクレジットを説明。請求クレジットと現金返金を区別。
- 解約期限、未使用分、サービスを提供できない場合、返金手段を説明。
- カード会社への異議申立てをサポートへの事前連絡で制限しない。
- AWSでのDB保守・復元検証、運用ログ、アクセス情報を取得・委託の説明に追加。
- 削除の非同期処理と再試行、ログ・復元データの別管理、AIデータの保存条件を説明。
- 他人の講座に投稿した共有Q&Aは、ユーザーとの紐付けを外して本文が残る実装のため、
  本文内の個人情報まで自動匿名化されるとは案内しない。投稿削除の依頼方法を明示。
- 共有Q&Aの閲覧範囲と、認可した外部アプリへの提供を明示。個人AIチャットは自動公開しない。
- 国外処理と安全管理、事業者住所の回答窓口、開示請求手続を補足。
- 機微情報の除去と、第三者の個人情報を送る際の必要な同意等を利用者へ案内。
- 故意・重過失と無料利用者に賠償上限を適用しないことを明確化。
- 規約変更は法令に基づき、効力発生日・変更内容を事前通知する形に修正。

## 国外移転・委託の判断資料

DPA が存在することと、日本の個人情報保護法28条の基準適合体制が確保されていることは
同じ結論ではない。国外委託は、同意を根拠にする場合と、相当措置を確保する契約等を
根拠にする場合を区別する。GDPR/SCC の記載だけで日本法上の確認完了としない。

| 事業者 | 公式資料から確認したこと | 継続して確認する事項 |
| --- | --- | --- |
| OpenRouter | [利用規約10.2](https://openrouter.ai/terms)に商用利用者のDPAを組込み。[DPA](https://openrouter.ai/data-processing-agreement)に指示に基づく処理、秘密保持、再委託先への保護義務、本人請求への協力、削除を規定。 | DPAのData Protection Laws定義はEU/英国/スイス/米国を列挙。日本の本人請求等を含む相当措置の適用範囲を別途確認する必要がある。モデル提供元の条件と処理国、変更の把握も必要。機微情報は標準契約では想定されていない。 |
| Cloudflare | [DPA](https://www.cloudflare.com/cloudflare-customer-dpa/)と[日本向け説明](https://cf-assets.www.cloudflare.com/slt3lc6tev37/1WB4s04w9rlqc2Rrvu7PwW/ecc8e0815aba8f9f42b0ce7a2ce76c8a/How_Cloudflare_helps_address_data_protection___locality_obligations_in_Japan.pdf)がある。 | 契約の適用範囲、再委託先・処理国、Workersログのアカウント別保持設定。 |
| Neon | [現行サービス条件](https://neon.com/platform-terms)は2026-10-14改定でDatabricksのMCSA・DPAを参照。古いNeon DPA PDFだけを根拠にしない。 | 実アカウントに適用される条件、DBリージョンはHyperdriveの接続先からシンガポールと確認済み。PITRの保持期間、現行DPAに基づく国外移転条件。 |
| AWS | [データプライバシー資料](https://aws.amazon.com/compliance/data-privacy-faq/)と本番東京リージョンを確認。 | サポート等を含む処理範囲、DPAの適用と外的環境の把握。東京実行だけで「全データ国内完結」としない。 |
| Mailgun | [現行規約](https://www.mailgun.com/legal/terms/)はSinchのDPAを参照。`mailgun.com/legal/dpa/` は旧版へ転送するため現行契約の唯一の根拠にしない。 | Sinchの現行DPA、契約主体、メール保管期間、サブプロセッサ・リージョン。 |
| Stripe | [DPA](https://stripe.com/legal/dpa)は契約へ組込み。決済・不正対策等ではcontrollerとしての取扱いもある。 | [日本向けDPA](https://stripe.com/en-jp/legal/dpa)と移転条件、法令上保持する記録、Checkoutの最終確認画面。 |
| SearchAPI / Google | 現実の用途はYouTube字幕取得・選択時のGoogle認証。 | 送信するID・認証情報の範囲、本人データに該当する場合の移転根拠。SearchAPIは利用者の契約も関係する。 |

法的な判断基準:
[国外委託のQ&A](https://www.ppc.go.jp/all_faq_index/faq1-q12-1/)、
[外国第三者提供ガイドライン](https://www.ppc.go.jp/personalinfo/legal/guidelines_offshore/)、
[クラウド利用のQ&A](https://www.ppc.go.jp/all_fad_index/fad2-3-2-q3/)、
[住所・電話の省略条件](https://www.no-trouble.caa.go.jp/qa/advertising.html)。

## 公開・完了前に必要なこと

1. 修正文と、故意・重過失・返金等の契約条件を運営者が確認して本番反映を承認する。
2. OpenRouter等の国外移転根拠を確定する。特に日本法の相当措置の範囲を確認し、必要なら
   事業者との追加条件の確認または情報提供を伴う同意取得を行う。
   追加契約の締結や事業者へのメール送信は本作業では行っていない。
3. 旧APIログの30日保持への変更は、運営者承認後に実施済み。
   AWS APIで保持日数を確認。既存ログの物理削除はAWS側の非同期処理であり、完了未確認。
4. Stripe Checkoutの返金補足文は下記へ保存・再読み込み確認済み。追加案内を指定したテストCheckoutで日英各4プランの金額・周期・自動更新・解約条件・同意欄を表示確認済み。本番反映後にも確認する。
   設定画面の確認だけで、個別の最終申込み画面の確認を代替しない。
5. 公開後に日英8URLの本文・フッター・関連リンクを確認し、必要な変更通知を行う。
   変更日が同じ日でも、既存利用者への必要な周知を省略しない。

委託先・モデル・送信データ・課金設定が変わるときは再確認する。国外移転の相当措置を
根拠にする場合は、法令に従って継続実施を定期確認し、本人への情報提供に対応する。
この記録は確認できた範囲と残作業を示すもので、法的適合性の確定判断ではない。

## 承認後に反映する具体案

ローカル検証: フロントエンドの本番ビルド成功。日英8ページの生成HTMLを解析して、
全見出し・全条項・全特商法項目が最新翻訳文と一致することを確認。
既存の画面遷移・動的翻訳キー・ランディング計測の3ファイル、86テストが成功。
`git diff --check` も成功。これらは法的判断や本番反映後の検証を代替しない。
続く確認でChromeのローカル表示を使い、日英8ページの見出しと画面を確認。
日本語プライバシーポリシーは末尾の追加条項・関連リンク・フッターも表示確認した。
長文・URLの折り返し、条項間隔、特商法表の表示に崩れは見られなかった。
これはデスクトップ表示の確認であり、本番公開後の確認とは区別する。

Stripe Checkout の返金補足文（他の設定はこの変更の対象外）:

> デジタルサービスのため物理的な返品はありません。解約は課金期間末に効力を生じます。重複課金、決済エラー、サービスを提供できない場合や法令上必要な返金は support@videoq.jp へご連絡ください。詳細は返金・解約ポリシーをご確認ください。

旧APIのログを30日に変更したコマンド（運営者承認後、実行済み）:

```sh
aws logs put-retention-policy --region ap-northeast-1 \
  --log-group-name /aws/lambda/videoq-api-prod --retention-in-days 30
```

`describe-log-groups` で保持日数30を再取得して確認済み。削除そのものはAWS側で遅延する
場合があるので、設定変更の成功を即時削除完了と報告しない。

OpenRouter へ日本法上の適用範囲を確認する問い合わせ案（未送信）:

宛先: `support@openrouter.ai`（公式DPAに記載）。
件名案: `APPI Article 28 safeguards for VideoQ commercial API use`。
事業者への送信と追加契約の締結は別の操作であり、この案は新たな契約への同意を含まない。

> We operate VideoQ (https://videoq.jp), a Japanese video-learning SaaS using
> OpenRouter for transcription, embeddings and chat inference. Your Terms of
> Service incorporate the DPA for commercial users, but section 1.7 of the DPA
> lists EU, UK, Swiss and US laws. Please confirm which contractual safeguards
> apply to personal data transferred from Japan under APPI Article 28, including
> data-subject requests, onward processing by model providers, deletion,
> country/location information and evidence of continuing safeguards. If an
> APPI-specific addendum is needed, please provide it for review. Please also
> clarify the scope of Sensitive Data restrictions for ordinary educational
> video/audio and course-context processing. We are not requesting execution of
> a new agreement or a paid-plan change at this stage.

## 2026-11-11 の追加検証

Checkoutに日英・Basic/Pro・月額/年額に対応した規約同意と確認文を追加。利用枠はカタログから取得し、自動更新、UTC月次リセット、期間末解約、返金条件、4つの規約リンクを案内する。CheckoutとSubscriptionのmetadataへ `legalPolicyVersion=2026-11-11` を記録する。metadataだけでは同意を証明しない。実際のSessionのconsentと併せて確認する。

API決済関連4ファイル31テストと最新フロントエンド本番ビルドが成功。実際のStripe画面や本番反映後の検証を代替しない。プライバシー本文にシンガポールのDB処理と提供元の例を追記。

PPCの外国第三者提供ガイドライン4-2に従い、日本法の全条文を契約へ明記すること自体は必須としない。処理指示・安全管理・再委託・漏えい通知・本人請求協力・削除等の実質的な保護を確認する。OpenRouterの日本法に基づく本人請求協力の範囲と機微情報制限は、国名記載とは別の確認事項として残る。通常の規約同意を国外移転の同意に読み替えない。相当措置と法制度による支障は少なくとも年1回および構成変更時に確認し、確保できない場合は該当送信を停止して代替手段を検討する。

Mailgunの現行Sinch DPA（2025-10-29版）3.1.4は、メール伝送・不正対策・通信網管理等で独立したcontrollerとなる範囲を定める。すべてをVideoQの指示だけによる委託処理と断定せず、日英プライバシー本文に補足した。出典: https://sinch.com/legal/terms-and-conditions/other-sinch-terms-conditions/data-processing-agreement/ 。

### Stripe hosted Checkout 表示検証

2026-11-11、既存Stripeテスト環境のWorkbenchから、JPY1,480/月のBasic表示検証用セッションを作成。`livemode=false`、`payment_status=unpaid`、`consent=null`、規約同意requiredをAPI応答で確認。公開Checkout画面で金額・月額周期、未選択の規約同意欄、日英のうち日本語4規約リンク、利用枠、自動更新、UTCリセット、期間末解約、返金例外、support@videoq.jp、申込ボタンを確認。カード・個人情報の入力、規約同意、申込完了は行っていない。

既存テスト価格は現行カタログと一致しないため、inline price_dataで検証用商品を生成した。今回はUI表示の検証であり、production APIの実リクエスト、価格lookup_key、顧客紐付け、住所収集、adaptive pricing無効化、webhookの検証とは区別する。この時点では英語・年額・Proは未確認だったが、後述の追加確認で完了した。スクリーンショット: `/tmp/videoq-legal-qa/stripe-checkout-test-ja-basic-monthly.png`（一時保存のため恒久証拠ではない）。

### Checkout 全プランの追加表示確認

2026-11-11、現行 `checkoutDisclosure` と `PLAN_CATALOG` を直接読み込んでStripe Shell用の引数を生成し、テスト環境へ送信。日本語Basic年額・Pro月額/年額、英語Basic月額/年額・Pro月額/年額のHosted Checkoutを開き、料金、請求周期、未選択の規約同意欄、言語別の4規約リンク、利用枠、更新・解約・返金条件が表示されることを確認した。初回の日本語Basic月額と合わせ、日英各4プランの確認が完了。

| 言語 | Basic月額 | Basic年額 | Pro月額 | Pro年額 |
| --- | --- | --- | --- | --- |
| 日本語 | ￥1,480/月 | ￥14,800/年 | ￥3,980/月 | ￥39,800/年 |
| 英語 | $9.99/month | $99.90/year | $26.99/month | $269.90/year |

2回目以降は住所収集requiredとAdaptive Pricing=falseも指定。商品・価格は隔離されたテスト用inline price_dataであり、本番のlookup_key解決や顧客連携の検証ではない。カード情報・個人情報の入力、規約同意、購入完了はしていない。画面テキストとスクリーンショットを `/tmp/videoq-legal-qa/` へ保存。これはDesktop画面の確認であり、モバイルと本番公開後の確認を意味しない。英語Pro月額スクリーンショットでは長い確認文が欄幅内で折り返されることも確認。

### 最新ビルドとの照合

日英8ページの生成HTMLをparse5で解析し、見出し・更新日・全条項・全特商法項目の計164フィールドが最新翻訳と一致し、関連ポリシーリンクが言語別URLへ向くことを確認。Mailgun補足後のビルドを対象とする。検証範囲とソースのSHA-256は `docs/verification/legal-policy-review-2026-11-11.json` に記録。公開判定は未完了であり、OpenRouterの実質的保護の確認、公開・公開後検証、既存利用者への必要な通知が残る。

## 既存利用者への変更通知案（未送信・未掲載）

現行コードにあるメール送信経路は認証・招待等の個別通知であり、規約改定の一斉配信・到達管理機能は確認できていない。公開日時・効力発生日を決めてから下記の日時欄を確定する。文面の更新日を効力発生日と自動的に同一視しない。既存契約への適用は、変更の法的要件と必要な同意を確認して行う。

### 日本語

件名: 【VideoQ】利用規約・プライバシーポリシー等の更新のお知らせ

VideoQのクラウド版について、利用規約、プライバシーポリシー、返金・解約ポリシー、特定商取引法に基づく表記を更新します。

掲載日: ［公開時に確定］
効力発生日: ［適用要件と事前通知期間を確認して確定］

主な変更は次のとおりです。

- Cloudflare・Neon・AWS・OpenRouter等の利用、国外での処理（データベースはシンガポール）、AI処理に送信する情報、メール配信事業者の取扱いを具体化しました。
- データ削除の手順・再試行、運用ログ等の別管理、他の利用者の講座に投稿した共有Q&Aの取扱いと削除依頼方法を明記しました。
- 通常の解約とアカウント削除の違い、即時プラン変更と日割り調整、返金の例外と問い合わせ手順を明確にしました。
- 故意・重過失や無料利用時の責任制限、規約変更の手続を見直しました。

変更後の全文をご確認ください。
利用規約: https://videoq.jp/terms
プライバシーポリシー: https://videoq.jp/privacy
返金・解約ポリシー: https://videoq.jp/refund
特定商取引法に基づく表記: https://videoq.jp/legal

ご質問、個人情報の開示・削除等のご相談は support@videoq.jp へご連絡ください。通常のサブスクリプション解約は設定画面のStripeポータルから行えます。

### English

Subject: [VideoQ] Updates to our terms and privacy policies

We are updating the Terms of Service, Privacy Policy, Refund and Cancellation Policy, and commerce disclosures for the cloud edition of VideoQ.

Publication date: [to be confirmed at release]
Effective date: [to be confirmed after checking applicable requirements and advance notice]

The updates describe our cloud and AI providers, processing outside Japan (including the database in Singapore), information sent for AI processing, and email providers' handling of information. They clarify deletion and retries, operational records, shared Q&A remaining in other users' courses, and how to request removal. They also clarify subscription cancellation versus account deletion, immediate plan changes and billing adjustments, refund exceptions, liability limitations, and the process for changing our terms.

Read the updated policies:
Terms: https://videoq.jp/en/terms
Privacy: https://videoq.jp/en/privacy
Refunds and cancellation: https://videoq.jp/en/refund
Commerce disclosures: https://videoq.jp/en/legal

Contact support@videoq.jp with questions or personal-data access/deletion requests. You can cancel a regular subscription through the Stripe portal in Settings.

### 公開時の確認記録

公開するcommit、公開日時、確定した効力発生日、通知の対象・方法・実施日時・結果、必要な個別同意の取扱いをこの記録へ追記する。全文リンクは本番反映後に確認する。文案中の未確定欄が残った状態では利用者へ送信・掲載しない。この文案の作成は、利用者へのメール送信の実施を意味しない。
