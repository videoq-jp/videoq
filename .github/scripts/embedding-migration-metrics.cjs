/** Offline scoring of frozen source anchors; never treats unjudged hits as proven irrelevant. */
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
function scoreEmbeddingComparison(labels, rows, samples = 3) {
  const cases = labels.cases;
  if (!cases?.length || !Number.isInteger(samples) || samples < 1) throw Error('Invalid evaluation cases');
  const ids = cases.map(c => c.id);
  if (new Set(ids).size !== ids.length || cases.some(c => !c.anchors?.length || new Set(c.anchors).size !== c.anchors.length)) throw Error('Invalid source anchors');
  const expectedIds = [...ids, ...(labels.diagnostics ?? []).map((_, i) => `diagnostic-${i}`)];
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.model}:${row.id}:${row.sample}`;
    if (!['openai', 'gemma'].includes(row.model) || !expectedIds.includes(row.id) || !Number.isInteger(row.sample) || row.sample < 0 || row.sample >= samples || byKey.has(key)
      || !Array.isArray(row.hits) || new Set(row.hits.map(h => h.id)).size !== row.hits.length
      || row.hits.some(h => typeof h.id !== 'string' || !Number.isFinite(h.score))
      || !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0
      || !Number.isInteger(row.ownerLeak) || row.ownerLeak < 0 || !Number.isInteger(row.scopeLeak) || row.scopeLeak < 0) throw Error('Invalid or duplicate search result');
    byKey.set(key, row);
  }
  if (byKey.size !== expectedIds.length * 2 * samples) throw Error('Incomplete search comparison');
  const models = {};
  for (const model of ['openai', 'gemma']) {
    const scored = cases.map(c => {
      const observations = Array.from({ length: samples }, (_, i) => byKey.get(`${model}:${c.id}:${i}`));
      if (observations.some(r => !r)) throw Error('Missing repeated result');
      const scores = observations.map(r => {
        const ranked = r.hits.slice(0, 20).map(h => h.id), first = ranked.findIndex(id => c.anchors.includes(id));
        return { hit1: Number(first === 0), hit5: Number(first >= 0 && first < 5), hit20: Number(first >= 0), mrr20: first >= 0 ? 1 / (first + 1) : 0,
          knownAnchorRecall20: c.anchors.filter(id => ranked.includes(id)).length / c.anchors.length };
      });
      return { id: c.id, ...Object.fromEntries(Object.keys(scores[0]).map(k => [k, mean(scores.map(v => v[k]))])),
        ranksStable: observations.every(r => JSON.stringify(r.hits.map(h => h.id)) === JSON.stringify(observations[0].hits.map(h => h.id))) };
    });
    const normalRows = rows.filter(r => r.model === model && ids.includes(r.id));
    models[model] = { questions: cases.length, samples, ...Object.fromEntries(['hit1', 'hit5', 'hit20', 'mrr20', 'knownAnchorRecall20'].map(k => [k, mean(scored.map(c => c[k]))])),
      stableQuestions: scored.filter(c => c.ranksStable).length,
      queryApiLatencyMs: { p50: percentile(normalRows.map(r => r.elapsedMs), .5), p95: percentile(normalRows.map(r => r.elapsedMs), .95) },
      cases: scored };
  }
  const ownerLeakage = rows.reduce((n, r) => n + r.ownerLeak, 0), scopeLeakage = rows.reduce((n, r) => n + r.scopeLeak, 0);
  const delta = Object.fromEntries(['hit1', 'hit5', 'hit20', 'mrr20', 'knownAnchorRecall20'].map(k => [k, models.gemma[k] - models.openai[k]]));
  const gates = labels.gates;
  const checks = { anchorHit5: delta.hit5 >= gates.anchorHitAt5DeltaMin, anchorHit20: delta.hit20 >= gates.anchorHitAt20DeltaMin,
    anchorMrr20: delta.mrr20 >= gates.anchorMrrAt20DeltaMin, ownerIsolation: ownerLeakage <= gates.ownerLeakageMax, scopeIsolation: scopeLeakage <= gates.scopeLeakageMax };
  return { version: 1, labelMethod: labels.labelMethod, models, delta, ownerLeakage, scopeLeakage, checks, qualityGatePassed: Object.values(checks).every(Boolean),
    limitation: 'Source-anchor hit/rank regression only. Not exhaustive relevance recall, human review, or proof of a completed production cutover.' };
}
module.exports = { scoreEmbeddingComparison };
if (require.main === module) {
  const fs = require('node:fs');
  if (process.argv.length !== 4) throw Error('Usage: node embedding-migration-metrics.cjs labels.json retrieval-results.json');
  process.stdout.write(JSON.stringify(scoreEmbeddingComparison(JSON.parse(fs.readFileSync(process.argv[2])), JSON.parse(fs.readFileSync(process.argv[3]))), null, 2) + '\n');
}
