const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const root=join(__dirname,'../..');
const docker=readFileSync(join(root,'apps/inference/whisper/Dockerfile.vllm'),'utf8');
const refresh=readFileSync(join(root,'apps/inference/whisper/Dockerfile.vllm-base'),'utf8');
const workflow=readFileSync(join(root,'.github/workflows/onprem-runtime-base.yml'),'utf8');
const job=name=>workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z-]+:|$(?![\\s\\S]))`,'m'))[1];

test('ordinary GPU builds use the recorded immutable runtime and do not contact package repositories',()=>{
 const evidence=JSON.parse(readFileSync(join(root,'apps/inference/whisper/security/runtime-base.json'),'utf8'));
 assert.match(evidence.digest,/^sha256:[a-f0-9]{64}$/);
 assert.match(evidence.sourceSha,/^[a-f0-9]{40}$/);
 assert.equal(docker.match(/^FROM (.+)$/m)[1],`${evidence.image}@${evidence.digest}`);
 assert.doesNotMatch(docker,/apt-get|pip install|curl |wget /);
 for(const check of ['verify_kernel_headers.py','verify_apt.py','verify_inference_runtime.py']) assert.ok(docker.includes(check));
 assert.ok(docker.indexOf('USER 10001:10001')<docker.indexOf('RUN python3 /usr/share/videoq/security/verify_inference_runtime.py'));
});

test('dependency refresh still requires complete APT indexes and the fixed runtime versions',()=>{
 assert.match(refresh,/APT::Update::Error-Mode=any update/);
 assert.match(refresh,/vllm\[audio\]==0\.32\.0/);
 for(const check of ['verify_kernel_headers.py','verify_apt.py','verify_inference_runtime.py']) assert.ok(refresh.includes(check));
 assert.doesNotMatch(refresh,/allow-unauthenticated|trusted=yes|DISABLE_VERSION_CHECK/);
});

test('runtime refresh requires successful current-main CI and scans before privileged publication',()=>{
 assert.match(job('source'),/require\('\.\/.github\/scripts\/validate-deployment.cjs'\)/);
 assert.match(job('source'),/refs\/heads\/main/);
 assert.match(job('build'),/needs: source/);
 assert.match(job('build'),/permissions:\n      contents: read\n/);
 assert.doesNotMatch(job('build'),/id-token: write|packages: write|secrets\./);
 assert.match(job('build'),/uses: \.\/\.github\/actions\/build-onprem-image/);
 assert.match(job('build'),/security-config: apps\/inference\/whisper\/security\/trivy.yaml/);
 assert.match(job('publish'),/needs: \[source, build\]/);
 for(const name of ['build','publish']){
   assert.match(job(name),/ref: \$\{\{ github\.sha \}\}/);
   assert.doesNotMatch(job(name),/ref:.*needs\.source\.outputs/);
 }
 assert.match(job('publish'),/id-token: write/);
 assert.doesNotMatch(job('publish'),/docker (?:build |run )|pip install|npm (?:ci|install)/);
 assert.match(job('publish'),/runtime-base-\$GITHUB_SHA-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/);
 assert.match(job('publish'),/Sign source provenance/);
 assert.match(job('publish'),/Sign the package inventory/);
 for(const action of workflow.matchAll(/uses: [^@\n]+@(\S+)/g)) assert.match(action[1],/^[a-f0-9]{40}$/);
});
