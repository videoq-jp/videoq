const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreEmbeddingComparison } = require('./embedding-migration-metrics.cjs');
const labels = { labelMethod: 'synthetic source anchors', cases: [{ id: 'q1', anchors: ['a'] }], diagnostics: ['unanswerable'], gates: {
  anchorHitAt5DeltaMin: -.02, anchorHitAt20DeltaMin: 0, anchorMrrAt20DeltaMin: -.02, ownerLeakageMax: 0, scopeLeakageMax: 0,
} };
function rows() { return ['openai', 'gemma'].flatMap(model => ['q1', 'diagnostic-0'].flatMap(id => [0, 1, 2].map(sample => ({
  model, id, sample, ownerLeak: 0, scopeLeak: 0, elapsedMs: 10, hits: id === 'q1' ? [{ id: 'a', score: .9 }] : [],
})))); }
test('scores independent questions and excludes no-answer diagnostics from anchor quality', () => {
  const report = scoreEmbeddingComparison(labels, rows());
  assert.equal(report.models.gemma.questions, 1); assert.equal(report.models.gemma.hit20, 1);
  assert.equal(report.models.openai.mrr20, 1); assert.equal(report.qualityGatePassed, true);
  assert.equal(report.models.gemma.stableQuestions, 1);
});
test('detects rank regression even if both models find the anchor in the top 20', () => {
  const input = rows().map(r => r.model === 'gemma' && r.id === 'q1' ? { ...r, hits: [{ id: 'unjudged', score: .95 }, ...r.hits] } : r);
  const report = scoreEmbeddingComparison(labels, input);
  assert.equal(report.delta.hit20, 0); assert.equal(report.delta.mrr20, -.5); assert.equal(report.qualityGatePassed, false);
});
test('fails isolation for diagnostic cases too', () => {
  const input = rows(); input[1].ownerLeak = 1;
  assert.equal(scoreEmbeddingComparison(labels, input).checks.ownerIsolation, false);
});
test('rejects incomplete samples, duplicates and invalid scores rather than silently improving averages', () => {
  const input = rows(); assert.throws(() => scoreEmbeddingComparison(labels, input.slice(1)));
  assert.throws(() => scoreEmbeddingComparison(labels, [...input, input[0]]));
  assert.throws(() => scoreEmbeddingComparison(labels, input.map((r, i) => i ? r : { ...r, hits: [...r.hits, ...r.hits] })));
  assert.throws(() => scoreEmbeddingComparison(labels, input.map((r, i) => i ? r : { ...r, hits: [{ id: 'a', score: NaN }] })));
});
