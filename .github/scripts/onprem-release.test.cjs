const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {runInNewContext} = require('node:vm');
const workflow = readFileSync(join(__dirname,'../workflows/onprem-release.yml'),'utf8');
const job = name => workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z-]+:|$(?![\\s\\S]))`,'m'))[1];

test('release gates publication on the existing current-main push-CI policy',()=>{
  const source = job('source');
  assert.match(source,/github\.ref == 'refs\/heads\/main'/);
  assert.match(source,/ref: \$\{\{ github.workflow_sha \}\}/);
  assert.match(source,/require\('\.\/.github\/scripts\/validate-deployment.cjs'\)/);
  assert.match(workflow,/^permissions:\n  contents: read\n/m);
  for(const name of ['build','chart']) assert.match(job(name),/needs: source/);
  assert.match(source,/await validate\(\{ github, context \}\)/);
  assert.match(source,/require\('\.\/.github\/scripts\/onprem-release-needed.cjs'\)/);
  for(const name of ['upstream-vllm','build','chart']) {
    assert.match(job(name),/if: needs.source.outputs.needed == 'true'/);
  }
});

test('both native architecture builds are credential-free and scan the archive before preparing publication',()=>{
  const build = job('build');
  assert.match(build,/permissions:\n      contents: read\n    steps:/);
  assert.match(build,/arch: \[amd64, arm64\]/);
  assert.match(build,/uses: \.\/\.github\/actions\/build-onprem-image/);
  assert.doesNotMatch(build,/secrets\.|id-token: write|packages: write|continue-on-error/);
  assert.match(build,/component: \[api, worker, web, transcription-gateway\]/);
  assert.doesNotMatch(build,/vllm-engine|Dockerfile\.vllm/);
});

test('the signed bundle includes the inference chart and NVIDIA assessment reports',()=>{
  assert.match(job('chart'),/helm" package charts\/videoq-inference/);
  assert.match(job('upstream-vllm'),/uses: \.\/\.github\/workflows\/upstream-vllm.yml/);
  assert.match(job('build'),/evidence-name: security-/);
  assert.match(job('staging'),/verified-inference.json/);
});

test('release assessments apply only to their matching inference component',()=>{
  const expression=job('build').match(/security-config: \$\{\{ (.*?) \}\}/)[1];
  const policy=component=>runInNewContext(expression,{matrix:{component}},{timeout:100});
  assert.equal(policy('transcription-gateway'),'apps/inference/whisper/security/cpu-trivy.yaml');
  assert.equal(policy('vllm-engine'),'');
  for(const component of ['api','worker','web','unknown']) assert.equal(policy(component),'');
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
  assert.match(job('publish'),/needs: \[source, build, upstream-vllm\]/);
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

test('each registry-writing job installs pinned ORAS before using it and logs out afterwards',()=>{
  for(const name of ['publish','indexes']){
    const text=job(name);
    const setup=text.indexOf('uses: oras-project/setup-oras@5e2f2482b30b0cb3e14e67f89a80c88c659a7c63');
    const login=text.indexOf('oras login --registry-config');
    const sign=text.indexOf('uses: actions/attest@');
    const logout=text.indexOf('oras logout --registry-config');
    assert(setup>=0 && login>setup && sign>login && logout>sign,name);
    assert.match(text,/checksum: 66fb0ad7206f3f6fa77ed5b552049d364ccf4b50b1684554f731f76302b52ca0/);
    assert.match(text,/if: \$\{\{ always\(\) && \(steps.image.outcome/);
  }
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
  const push=publish.indexOf('oras cp --from-oci-layout');
  const after=publish.indexOf('onprem_registry.py "$COMPONENT"',push);
  assert(before>=0 && push>before && after>push);
  assert.doesNotMatch(workflow,/--allow-missing/);
  assert.match(publish,/repository="ghcr.io\/videoq-jp\/videoq-\$COMPONENT"/);
  const indexes=job('indexes');
  assert(indexes.indexOf('onprem_registry.py "$COMPONENT"')<indexes.indexOf('docker buildx imagetools create'));
  const staging=job('staging');
  assert(staging.indexOf('onprem_registry.py "$component"')<staging.indexOf('onprem-release.py verify'));
});

test('browser setup retries transient failures but never passes after three failures',()=>{
  const {mkdtempSync,writeFileSync,chmodSync,rmSync}=require('node:fs');
  const {tmpdir}=require('node:os');
  const {spawnSync}=require('node:child_process');
  const block=workflow.split('      - name: Install Chromium and OS dependencies with bounded retries\n')[1].split('\n      - ')[0];
  const script=block.split('        run: |\n')[1].split('\n').map(line=>line.replace(/^          /,'')).join('\n');
  for(const failures of [2,3]){
    const directory=mkdtempSync(join(tmpdir(),'videoq-browser-retry-'));
    try{
      const counter=join(directory,'counter');
      writeFileSync(join(directory,'node'),'#!/bin/sh\ncount=0\nif [ -f "$TEST_COUNTER" ]; then read -r count < "$TEST_COUNTER"; fi\ncount=$((count+1))\nprintf "%s\\n" "$count" > "$TEST_COUNTER"\nif [ "$count" -le "$TEST_FAILURES" ]; then exit 1; fi\nexit 0\n');
      writeFileSync(join(directory,'sleep'),'#!/bin/sh\nexit 0\n');
      for(const name of ['node','sleep']) chmodSync(join(directory,name),0o700);
      const result=spawnSync('bash',['-e','-c',script],{env:{...process.env,PATH:directory+':'+process.env.PATH,TEST_COUNTER:counter,TEST_FAILURES:String(failures)},encoding:'utf8'});
      assert.equal(result.status,failures===2?0:1,result.stderr);
      assert.equal(readFileSync(counter,'utf8').trim(),'3');
    }finally{rmSync(directory,{recursive:true,force:true})}
  }
});

test('on-prem hosts use an explicit supported Ubuntu baseline',()=>{
 const validation=readFileSync(join(__dirname,'../workflows/onprem-validation.yml'),'utf8');
 for(const source of [workflow,validation]){
   assert.doesNotMatch(source,/runs-on:.*ubuntu-latest/);
   assert.match(source,/runs-on:.*ubuntu-24\.04/);
 }
});

test('DNS repair cannot restart the lifecycle job service containers',()=>{
 const validation=readFileSync(join(__dirname,'../workflows/onprem-validation.yml'),'utf8');
 const lifecycle=validation.split('  onprem:\n')[1].split('  whisper-nvidia-image:\n')[0];
 assert.match(lifecycle,/services:\n      postgres:/);
 assert.match(lifecycle,/run: python3 \.github\/scripts\/configure-onprem-ci-dns\.py\n/);
 assert.doesNotMatch(lifecycle,/configure-onprem-ci-dns\.py --docker/);
 assert.match(job('build'),/uses: \.\/\.github\/actions\/build-onprem-image/);
});
