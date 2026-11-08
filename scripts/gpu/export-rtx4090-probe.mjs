// Export a private Runpod process probe from the actual three-Pod Helm profile.
// This creates no cloud resources and never substitutes for K3s acceptance.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseAllDocuments} from 'yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [lock, output] = process.argv.slice(2);
if (!lock || !output) throw new Error('Usage: HELM_BIN=helm node scripts/gpu/export-rtx4090-probe.mjs VERIFIED_INFERENCE_JSON NEW_PLAN_JSON');
const profile = 'charts/videoq-inference/examples/rtx4090.yaml';
const resources = parseAllDocuments(execFileSync(process.env.HELM_BIN || 'helm', [
  'template', 'inference', 'charts/videoq-inference', '-f', profile, '-f', resolve(lock),
], {cwd: root, encoding: 'utf8'})).filter(d => d.contents).map(d => d.toJSON());
const roles = {};
for (const role of ['embedding', 'whisper', 'chat']) {
  const pod = resources.find(d => d.kind === 'Deployment' && d.metadata.name === `videoq-inference-${role}`)?.spec.template.spec;
  const engine = pod?.containers.find(c => c.name === (role === 'whisper' ? 'engine' : role));
  const provision = pod?.initContainers.find(c => c.name === 'provision-model');
  if (engine?.resources.limits['nvidia.com/gpu.shared'] !== 1 || engine.resources.limits['nvidia.com/gpu'] || !provision) throw new Error('Expected the actual shared-GPU profile with model provisioning');
  if (JSON.stringify(engine.command) !== JSON.stringify(['vllm', 'serve'])) throw new Error('All three roles must execute vLLM');
  if (!/^ghcr\.io\/videoq-jp\/videoq-vllm@sha256:[a-f0-9]{64}$/.test(engine.image)) throw new Error('A verified immutable VideoQ NVIDIA image is required');
  const environment = Object.fromEntries(provision.env.map(e => [e.name, e.value]));
  roles[role] = {image: engine.image, command: [...engine.command, ...engine.args], environment: Object.fromEntries(engine.env.map(e => [e.name, e.value])),
    model: {repo: environment.MODEL_REPO, revision: environment.MODEL_REVISION, file: environment.MODEL_FILE, sha256: environment.MODEL_SHA256}};
}
if (new Set(Object.values(roles).map(r => r.image)).size !== 1) throw new Error('The three roles must use the same reviewed runtime image');
const sha256 = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const plan = {schema: 1, scope: 'one-container-three-process-preliminary-probe-not-k3s', sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
  sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], {cwd: root, encoding: 'utf8'}).trim()),
  profileSha256: sha256(profile), runnerSha256: sha256('scripts/gpu/runpod-rtx4090-probe.py'),
  roles, embeddingDimensions: 1536, vllmVersion: '0.32.0', adaptations: ['Loopback-only listeners', 'Embedding port 8001 instead of isolated-Pod port 8000', 'Caller-selected persistent model root']};
writeFileSync(output, JSON.stringify(plan, null, 2) + '\n', {flag: 'wx', mode: 0o600});
console.log(`Exported preliminary probe plan to ${output}; no cloud instance created`);
