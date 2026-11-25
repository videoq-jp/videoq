// Required native gate: run only after locked npm dependencies and reviewed Helm setup.
const assert = require('node:assert/strict');
const {verifyWorkload, nativeMasks} = require('./check-vllm-applicability.cjs');
  const {execFileSync} = require('node:child_process');
  const {readFileSync} = require('node:fs');
  const {parseAllDocuments} = require('yaml');
  const policy = JSON.parse(readFileSync('apps/inference/vllm/security/runtime-assessment.json'));
  for (const profile of ['gpt-oss-embeddinggemma', 'vllm-nvidia', 'whisper-nvidia', 'rtx4090', 'rtx4090-gpt-oss-embeddinggemma']) {
    for (const extra of [[], ['--set', 'downloadModels=false', '--set', 'networkPolicy.denyEgress=true']]) {
      const text = execFileSync(process.env.HELM_BIN || 'helm', ['template', 'assessment', 'charts/videoq-inference',
        '-f', 'charts/videoq-inference/examples/' + profile + '.yaml', ...extra], {encoding: 'utf8'});
      const docs = parseAllDocuments(text).map(doc => {assert.equal(doc.errors.length, 0); return doc.toJSON();}).filter(Boolean);
      verifyWorkload(docs, policy);
    }
  }
  for (const workflow of ['upstream-vllm.yml', 'patched-audio-candidate.yml']) {
    const text = readFileSync('.github/workflows/' + workflow, 'utf8');
    for (const directory of nativeMasks) assert.ok(text.includes('--tmpfs ' + directory + ':ro,size=1m'));
  }

console.log('Validated all 10 supported native profile renders and both four-mask workflows');
