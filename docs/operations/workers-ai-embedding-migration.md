# Workers AI埋め込み移行

2026-11-22。生成経路は[PR #1597](https://github.com/videoq-jp/videoq/pull/1597)。上流は[JS #12285](https://github.com/langchain-ai/langchainjs/pull/12285)と[Python #103](https://github.com/cloudflare/langchain-cloudflare/pull/103)で、取り込み待ちの間はLangChain OpenAIEmbeddingsからAI bindingへ接続する。

## ロボットビジョン講座での比較

同じ16動画・420字幕シーンを使用し、本文・シーン境界を変更せずに`@cf/google/embeddinggemma-2`で再生成した。検索語は`task: search result | query: `、文書は`title: none | text: `を使用した。現行の1536次元ベクトルは生成し直さず、配信中のVectorizeから全420件を取得し、scene ID・revisionをD1と照合した。

検索結果を見る前に12テーマ・24質問と根拠scene、4件の範囲外診断質問を私有ファイルへ固定した。ラベルはAIが字幕本文を確認して選んだ根拠場面で、人手レビュー済みでも網羅的な正解集合でもない。一般的なRecallではなく、既知の根拠場面に対する取得率と順位の回帰を測る。

| 指標 | 現行OpenAI | EmbeddingGemma 2 |
|---|---:|---:|
| 根拠場面Hit@1 | 8/24 | 7/24 |
| 根拠場面Hit@5 | 15/24 | 16/24 |
| 根拠場面Hit@20 | 19/24 | 21/24 |
| 根拠場面MRR@20 | 0.47117 | 0.47805 |
| 3回の検索で順位が安定した質問 | 24/24 | 24/24 |

事前の相対基準はHit@5差−0.02以上、Hit@20差0以上、MRR差−0.02以上、所有者・講座範囲の越境0件。すべて満たした。上位1件の精度は下がっており、全質問・全講座での品質向上を意味しない。

同一ローカルクライアントからVectorize APIを交互に呼び、質問ごとに各3回測定した検索APIのp50は現行205.7ms／候補186.1ms、p95は238.5ms／236.6msだった。埋め込み生成、D1 hydration、回答生成を含まないため、アプリ全体の遅延比較とは扱わない。両モデルともスコア分布が違う。現在の検索は固定top-kであり、この小標本だけから共通の類似度しきい値を追加しない。

範囲外の4質問は根拠場面の取得率へ混ぜず、診断用とした。所有者不一致の負例56検索はすべて0件だった。通常・診断検索でも所有者と講座のmetadata範囲外への漏れは0件。

[集計結果](../validation/workers-ai-embedding-comparison-2026-11-22.json)には本文・所有者ID・個別scene IDを含めていない。raw入力・ベクトル・ラベル・個別順位は0700ディレクトリ／0600ファイルで私有保存した。

## 再計算

同じ形式の凍結済みラベルと検索結果から、モデルを呼ばずに採点できる。

```sh
node .github/scripts/embedding-migration-metrics.cjs /private/labels.json /private/retrieval-results.json > /private/scored-report.json
node --test .github/scripts/embedding-migration-metrics.test.cjs
```

欠けた反復・重複結果・不正スコアを拒否し、反復数を独立した質問数として数えない。

## 全講座への展開

現在の1536次元インデックスを残し、現行D1の全字幕を同じ境界で768次元へ再生成する。既存の未使用768次元データは移行前にバックアップする。公開は既存のsource revisionによる競合検出、staging、Vectorize配信確認を経由する。

検索側と字幕登録側は同じモデル・profile・入力形式へそろえて切り替える。全件の配信、権限境界、実検索・字幕登録の確認が済むまで本番切り替え完了とは扱わない。戻す場合は検索・登録の設定を現行OpenAI/1536次元へそろえ、保持した旧インデックスを使用する。
