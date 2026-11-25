import type { SkillView } from '@videoq/trpc/skills';
export const skillFixtureId = '3dc4072c-d22f-42f6-81e5-96f6686916ab';
export const reviewedSkill: SkillView = {
  id: skillFixtureId, stage: 'review', objective: '外部APIのレート制限と再試行を安全に実装・レビューする', language: 'ja',
  resourceTitle: 'APIクライアント設計', completedChunks: 2, totalChunks: 2, sourceVideos: 2, issues: [],
  skillName: 'videoq-rate-limited-client-3dc4072c',
  markdown: '---\nname: videoq-rate-limited-client-3dc4072c\ndescription: APIクライアントのレート制限と安全な再試行を設計・レビューする。\n---\n\n# APIクライアントの再試行\n\n## 判断基準\n- この演習では同時実行を2件までにする。\n\n## 手順\n1. HTTP 429ではRetry-Afterに基づく延期結果を返し、呼び出し元に再スケジュールを任せる。ヘルパー内でsleepや再試行をしない。\n\n## 例外\n- HTTP 401、または冪等性キーのないPOSTは自動再試行しない。\n\n## 検証\n- 偽の時計とレスポンス列で、429の後に即座の再リクエストが発生しないことを確認する。\n\n[根拠](references/sources.md)\n',
  sourcesMarkdown: '# 根拠\n\n## chunk-0-fact-0\nAPIクライアント設計 — 00:00:10,000 → 00:00:30,000\n> この演習では同時実行を2件までにします。429では延期結果を返し、ヘルパー内でsleepや再試行をしてはいけません。\n',
  draft: { slug: 'rate-limited-client', title: 'APIクライアントの再試行', description: 'APIクライアントのレート制限と安全な再試行を設計・レビューする。',
    useWhen: ['外部APIの呼び出しを設計・レビューするとき'], doNotUseWhen: ['別のAPIに演習固有の上限をそのまま適用しない'],
    criteria: [{ decision: '同時実行を2件までにする', factIds: ['chunk-0-fact-0'] }],
    steps: [{ action: '429では延期結果を返す', expectedResult: '呼び出し元が再スケジュールする', factIds: ['chunk-0-fact-0'] }],
    exceptions: [{ condition: '401', behavior: '再試行しない', factIds: ['chunk-0-fact-0'] }],
    checks: [{ check: '429後の再リクエストがない', factIds: ['chunk-0-fact-0'] }], examples: [], },
};

export const publishedSkillSet: SkillView = {
  ...reviewedSkill, automatic: true, objective: '', stage: 'published', draft: null, markdown: null, sourcesMarkdown: null, skillName: null,
  members: [
    { objective: reviewedSkill.objective, status: 'passed', issues: [], title: reviewedSkill.draft!.title,
      description: reviewedSkill.draft!.description, skillName: reviewedSkill.skillName, markdown: reviewedSkill.markdown, sourcesMarkdown: reviewedSkill.sourcesMarkdown },
    { objective: '遅いSQLを実行計画から診断する', status: 'passed', issues: [], title: 'SQLの実行計画を診断する',
      description: '遅いSQLをEXPLAINで調べ、インデックス追加前後の実行計画を検証する。', skillName: 'videoq-sql-plan-3dc4072c',
      markdown: '---\nname: videoq-sql-plan-3dc4072c\ndescription: 遅いSQLの実行計画を診断する。\n---\n\n# SQLの実行計画\n\nインデックスを追加する前にEXPLAINで実行計画を確認する。\n',
      sourcesMarkdown: '# 根拠\n\nSQL診断 — 00:01:00,000\n> インデックスを追加する前に実行計画を見ます。\n' },
  ],
};
