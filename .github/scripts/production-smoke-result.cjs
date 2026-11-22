const STAGES = new Set(['public-health', 'database-and-cleanup', 'synthetic-sign-in', 'upload', 'video-processing', 'cited-question-answer', 'cited-streaming-answer', 'unscoped-streaming-answer', 'browser']);
// Only fixed stage identifiers may cross from the child report into AWS logs.
// Never include report summaries, arbitrary details or child output in errors.
function assertProductionSmoke(report) {
  if (report?.status === 'ok') return;
  const details = Array.isArray(report?.details) ? report.details : [];
  const stage = details.map(value => typeof value === 'string' ? /^- 失敗した段階: `([a-z-]+)`。認証情報や利用者のデータはログに出力していません。$/.exec(value)?.[1] : undefined).find(value => STAGES.has(value));
  throw new Error('PRODUCTION_VERIFICATION_FAILED' + (stage ? '_STAGE_' + stage.replaceAll('-', '_').toUpperCase() : ''));
}
module.exports = {assertProductionSmoke};
