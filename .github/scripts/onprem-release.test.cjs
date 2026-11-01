const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const workflow = readFileSync(join(__dirname,'../workflows/onprem-release.yml'),'utf8');
const job = name => workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z-]+:|$(?![\\s\\S]))`,'m'))[1];

test('release gates publication on the existing current-main push-CI policy',()=>{
  const source = job('source');
  assert.match(source,/github\.ref == 'refs\/heads\/main'/);
  assert.match(source,/ref: \$\{\{ github.workflow_sha \}\}/);
  assert.match(source,/require\('\.\/.github\/scripts\/validate-deployment.cjs'\)/);
  assert.match(workflow,/^permissions:\n  contents: read\n/m);
  for(const name of ['build','chart']) assert.match(job(name),/needs: source/);
});

test('both native architecture builds are credential-free and scan before exporting',()=>{
  const build = job('build');
  assert.match(build,/permissions:\n      contents: read\n    steps:/);
  assert.match(build,/arch: \[amd64, arm64\]/);
  const scan=build.indexOf('uses: aquasecurity/trivy-action@');
  const archive=build.indexOf('docker save');
  assert(scan>=0 && archive>scan);
  assert.match(build,/exit-code: '1'/);
  assert.match(build,/ignore-unfixed: 'false'/);
  assert.doesNotMatch(build,/secrets\.|id-token: write|packages: write|continue-on-error/);
  assert.match(build,/component: \[api, worker, web, transcription-gateway\]/);
  assert.doesNotMatch(build,/component: vllm|apps\/inference\/vllm\/Dockerfile/);
  assert.match(build,/docker cp "\$container:\/usr\/share\/licenses\/videoq\/LICENSE" - \| tar -xO \| cmp LICENSE -/);
});

test('the signed bundle includes the inference chart and build scan reports',()=>{
  assert.match(job('chart'),/helm" package charts\/videoq-inference/);
  assert.doesNotMatch(job('build'),/trivy-config:/);
  assert.match(job('build'),/artifact\/security.json/);
  assert.match(job('build'),/retention-days: 90/);
  assert.doesNotMatch(job('indexes'),/!= vllm/);
  assert.match(job('staging'),/verified-inference.json/);
});

test('privileged jobs do not build images or execute application dependencies',()=>{
  for(const name of ['publish','indexes','release']){
    const text=job(name);
    assert.match(text,/id-token: write/);
    assert.doesNotMatch(text,/docker (?:build |run )|npm (?:ci|install|run)|pip install/);
    assert.doesNotMatch(text,/run-id:|github-token:/);
    for(const action of text.matchAll(/uses: actions\/attest@(\S+)/g)) assert.match(action[1],/^[a-f0-9]{40}$/);
    if(text.includes('uses: actions/checkout@')) assert.match(text,/persist-credentials: false/);
  }
  assert.match(job('publish'),/needs: \[source, build\]/);
  assert.match(job('indexes'),/needs: \[source, publish\]/);
  assert.match(job('release'),/needs: \[source, indexes, chart\]/);
});

test('staging verifies signed artifacts before loading or exercising them',()=>{
  const staging=job('staging');
  assert.match(staging,/needs: \[source, release\]/);
  assert.doesNotMatch(staging,/id-token: write|packages: write|secrets\./);
  const verify=staging.indexOf('onprem-release.py verify');
  const pull=staging.indexOf("['docker', 'pull'");
  const exercise=staging.indexOf('onprem-lab.py');
  assert(verify>=0 && pull>verify && exercise>pull);
  assert.match(staging,/--chart "release\/videoq-0.1.0-sha\.\$GITHUB_SHA\.tgz"/);
  assert.doesNotMatch(staging,/docker login|packages: read/);
  assert.match(staging,/registry-anonymous/);
  assert.match(staging,/auths/);
  assert.match(staging,/rm -rf "\$DOCKER_CONFIG"/);
});

test('release retries cannot mix artifacts from different attempts',()=>{
  for (const match of workflow.matchAll(/uses: actions\/(?:upload|download)-artifact@[^\n]+\n        with:\n([\s\S]*?)(?=^      -|^  [a-z-]+:|$(?![\s\S]))/gm)) {
    const identity = match[1].match(/^          (?:name|pattern): (.+)$/m)?.[1];
    assert(identity?.includes('${{ github.run_attempt }}'), identity);
  }
  assert.doesNotMatch(workflow,/overwrite: true/);
});

test('public distribution checks visibility around publication and before staging',()=>{
  const publish=job('publish');
  const before=publish.indexOf('onprem_registry.py "$COMPONENT"');
  const push=publish.indexOf('docker push "$tag"');
  const after=publish.indexOf('onprem_registry.py "$COMPONENT"',push);
  assert(before>=0 && push>before && after>push);
  assert.doesNotMatch(workflow,/--allow-missing/);
  assert.match(publish,/repository="ghcr.io\/videoq-jp\/videoq-\$COMPONENT"/);
  const indexes=job('indexes');
  assert(indexes.indexOf('onprem_registry.py "$COMPONENT"')<indexes.indexOf('docker buildx imagetools create'));
  const staging=job('staging');
  assert(staging.indexOf('onprem_registry.py "$component"')<staging.indexOf('onprem-release.py verify'));
});
