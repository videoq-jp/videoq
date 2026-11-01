---
title: Search engine visibility
description: How public pages reach crawlers, which search intents they serve, and how to check them.
---

# Search engine visibility

VideoQ serves real page content in the first HTML, with one page per search intent, correct status codes, and a read-only daily check. Measure Google organic acquisition with Search Console clicks and impressions. Signups are a separate product outcome; technical checks and rankings alone do not prove that search traffic increased.

## How public pages are served

| Path type | Examples | Response |
|---|---|---|
| Public | `/`, `/pricing`, `/try`, legal pages, `/guides`, `/guides/:slug`, and each under `/en` | Prerendered body, indexable, in the sitemap |
| Application | `/videos`, `/login`, `/share/:token` | 200 with the empty shell and `noindex` |
| Unknown | Anything else | 404 with the empty shell and `noindex` |

`npm run build` runs `apps/web/scripts/prerender.mjs` after the client build. It renders each public page with the same React tree the browser hydrates and generates `sitemap.xml`. The Worker then rewrites the head from `src/lib/pageCopy.ts` and `src/lib/seo.ts`. `publicPaths()` is the single list of public pages. On-prem builds skip all of this.

The plan cards on `/pricing` and the Free plan limits on the landing page still load in the browser, because prices come from Stripe at request time and must not go stale in a build.

## Search intents and pages

Search Console supplies observed queries and positions, but not the search volume for candidate queries with no impressions. This table is a hypothesis to test, not a demand ranking.

| Candidate queries | Page | What the reader gets |
|---|---|---|
| 動画講座 質問対応, オンライン講座 受講生 サポート, 講座 AI チャットボット | `/guides/online-course-questions` | Setup, access choice, costs, checks |
| 授業 録画 復習, 塾 授業動画 質問 | `/guides/class-recordings-for-review` | Dividing courses, sharing, using history |
| 研修動画 質問, 社内研修 動画 AI 検索 | `/guides/training-video-questions` | Invitations, attribution, rollout decisions |
| VideoQ 仕組み, 動画 AI 回答 引用 | `/guides/how-ai-answers-work` | Answer flow, limits, who reads questions |
| VideoQ, 動画講座 質問対応 自動化 | `/` | Product overview and demo |
| VideoQ 料金 | `/pricing` | Plans and limits |

## Adding or editing a guide

1. Add a page only when it serves a distinct intent with something the existing pages lack. Do not create variants for similar wording.
2. Add the entry to `src/lib/guideCatalog.ts` and the body to `src/content/guides.ts`, in Japanese and English.
3. Change `updated` only when the content changes. The sitemap publishes that date.
4. State only shipped behavior, checked against `docs/concepts`. Do not add invented figures, customers, testimonials or promised results.

`FAQPage` markup is deliberately not used. The FAQ is ordinary page content.

## Checks

```sh
npm run build --workspace @videoq/web
npm run test:worker --workspace @videoq/web
npm run seo:audit --workspace @videoq/web -- --base-url http://127.0.0.1:8787 --output /tmp/seo-audit.json
```

The `Daily public SEO checks` workflow runs the audit against production and keeps the report for 90 days. It checks status codes, HEAD responses, canonical, hreflang, titles, descriptions, H1, body text, JSON-LD validity, internal links and 404 behavior. It cannot measure indexing, rankings or field Core Web Vitals.

## Measuring results

Measure in Search Console for the `sc-domain:videoq.jp` domain property. A private baseline for October 1–28, 2026 was captured before these changes. Keep raw exports outside the public repository: queries and page reports can contain information that is unsuitable for publication.

For each comparison:

1. Record the deployed revision and publication date. Use `type=web` and finalized data, and record the reporting time zone (Search Console dates use Pacific Time).
2. Compare complete, equal 28-day windows. The first post-release window starts on the first full Pacific calendar day after deployment. Wait for all days to become available before making a traffic claim; do not compare a partial current window with a complete baseline.
3. Request property totals without dimensions (`dimensions: []`). Export daily, query, and page views separately. Query rows omit some anonymized queries; summing them is not the property total. Page aggregations also differ from property aggregations.
4. Report Google clicks, impressions, CTR and position together, with the small sample size when relevant. Separate the product host from developer documentation, and classify visible queries as brand or non-brand without treating the unreported queries as zero.
5. Attribute an increase cautiously: seasonality, brand searches and other releases can change traffic. Internal clicks from documentation to the product and demo completions are useful journey measures, but are not additional Google search clicks.

Confirm key URLs with URL Inspection, including Google's chosen canonical and latest crawl. Register `videoq.jp/sitemap.xml` and both docs locale sitemaps, `docs.videoq.jp/sitemap.xml` and `docs.videoq.jp/ja/sitemap.xml`, under the domain property. A submitted sitemap does not mean a page is indexed. The docs site advertises both locale sitemaps in its own `robots.txt` and publishes only the approved content manifest.

Daily automated content changes are not configured. Prefer an evidence-based update to an existing useful page over creating pages for slight keyword variations.
