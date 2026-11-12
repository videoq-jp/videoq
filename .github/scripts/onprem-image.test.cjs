const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync,writeFileSync,mkdtempSync,chmodSync,rmSync}=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {spawnSync}=require('node:child_process');
const action=readFileSync(join(__dirname,'../actions/build-onprem-image/action.yml'),'utf8');
const build=action.split('    - name: Build and verify the image\n')[1].split('\n    - name:')[0]
  .split('      run: |\n')[1].split('\n').map(line=>line.replace(/^        /,'')).join('\n');

// Run the real build orchestration with a fake Docker executable; no daemon or credentials.
function runBuild({failure='',mismatchedLicense=false}={}){
 const directory=mkdtempSync(join(tmpdir(),'videoq-image-pipeline-'));
 try{
  writeFileSync(join(directory,'LICENSE'),'expected license\n');
  writeFileSync(join(directory,'image-license'),mismatchedLicense?'wrong license\n':'expected license\n');
  writeFileSync(join(directory,'docker'),`#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$TEST_LOG"
if [ "$1 $2" = "$TEST_FAILURE" ]; then exit 7; fi
case "$1 $2" in
  'buildx build')
    case " $* " in
      *' --build-context '*) mkdir -p "$RUNNER_TEMP/image-check"; cp "$TEST_DIRECTORY/image-license" "$RUNNER_TEMP/image-check/LICENSE" ;;
      *) mkdir -p "$RUNNER_TEMP/scan-image"; printf '%s' '{"manifests":[{"digest":"sha256:${'a'.repeat(64)}"}]}' > "$RUNNER_TEMP/scan-image/index.json" ;;
    esac ;;
esac
`);
  chmodSync(join(directory,'docker'),0o700);
  const result=spawnSync('bash',['-e','-o','pipefail','-c',build],{cwd:directory,encoding:'utf8',env:{...process.env,
    PATH:directory+':'+process.env.PATH,TEST_LOG:join(directory,'commands'),TEST_FAILURE:failure,
    TEST_DIRECTORY:directory,RUNNER_TEMP:directory,IMAGE:'fixture:ci',DOCKERFILE:'Dockerfile',BUILD_CONTEXT:'.',
    PLATFORM:'linux/amd64',GITHUB_REPOSITORY:'videoq-jp/videoq',GITHUB_SHA:'a'.repeat(40)}});
  return {...result,commands:readFileSync(join(directory,'commands'),'utf8')};
 }finally{rmSync(directory,{recursive:true,force:true});}
}

test('image pipeline checks the shipped license through the exact OCI output without Docker loading',()=>{
 const result=runBuild();
 assert.equal(result.status,0,result.stderr);
 assert.match(result.commands,/--build-context release-image=oci-layout:\/\//);
 assert.ok(result.commands.indexOf('--build-context')<result.commands.indexOf('buildx prune'));
 assert.doesNotMatch(result.commands,/^load|^create|^run|^cp /m);
});

test('a build failure prevents verification, and a license mismatch prevents successful handoff',()=>{
 const failed=runBuild({failure:'buildx build'});
 assert.equal(failed.status,7);
 assert.ok(!failed.commands.includes('--build-context'));
 const mismatch=runBuild({mismatchedLicense:true});
 assert.notEqual(mismatch.status,0);
 assert.ok(!mismatch.commands.includes('buildx prune'));
});

test('one complete strict scan supplies both the inventory and the separate publisher',()=>{
 assert.equal([...action.matchAll(/uses: aquasecurity\/trivy-action@/g)].length,1);
 for(const setting of ["ignore-unfixed: 'false'",'severity: HIGH,CRITICAL',"exit-code: '1'","list-all-pkgs: 'true'"])
  assert.ok(action.includes(setting),setting);
 assert.ok(action.includes('trivy convert --format cyclonedx --output artifact/sbom.cdx.json artifact/security.json'));
 assert.doesNotMatch(action,/trivy image |docker save|continue-on-error|secrets\./);
 assert.doesNotMatch(action,/docker (?:load|create|run|cp) /);
 assert.ok(action.indexOf('uses: aquasecurity/trivy-action@')<action.indexOf('mv "$RUNNER_TEMP/scan-image" artifact/image'));
 assert.ok(action.includes("if: inputs.artifact-name != ''"));
 for(const name of ['onprem-release']){
  const workflow=readFileSync(join(__dirname,`../workflows/${name}.yml`),'utf8');
  assert.ok(workflow.includes('uses: ./.github/actions/build-onprem-image'),name);
  assert.doesNotMatch(workflow,/docker buildx build|scan-image.tar/,name);
 }
 for(const match of action.matchAll(/uses: [^@\n]+@(\S+)/g)) assert.match(match[1],/^[a-f0-9]{40}$/);
});


test('image-action changes select app image checks without selecting upstream GPU checks',()=>{
 const workflow=readFileSync(join(__dirname,'../workflows/ci.yml'),'utf8');
 const filter=name=>workflow.match(new RegExp(`^            ${name}:\\n([\\s\\S]*?)(?=^            \\w+:|^      - name:)`,'m'))[1];
 assert.ok(filter('onprem').includes("'.github/actions/build-onprem-image/**'"));
 assert.ok(!filter('whisper_gpu').includes("'.github/actions/build-onprem-image/**'"));
 for(const name of ['containers','hono','worker','frontend','docs']){
  assert.doesNotMatch(filter(name),/['"]\.github\/actions\/\*\*['"]/);
  assert.ok(filter(name).includes('.github/actions/setup-package-manager/**'),name);
 }
});


test('CUDA preparation fails before build when its working set cannot fit',()=>{
 const reserve=action.split('    - name: Reserve disk for CUDA\n')[1].split('    - uses:')[0];
 assert.ok(reserve.includes("if: inputs.cuda == 'true'"));
 const script=reserve.split("/usr/bin/python3 - <<'PYCODE'\n")[1].split('        PYCODE')[0]
   .split('\n').map(line=>line.replace(/^        /,'')).join('\n');
 for(const [free,passes] of [[59,false],[60,true]]){
  const code='import shutil,types,os; os.environ["RUNNER_TEMP"]="/fixture"; shutil.disk_usage=lambda _: types.SimpleNamespace(free='+free+'*1024**3); exec('+JSON.stringify(script)+')';
  const result=spawnSync('python3',['-c',code],{encoding:'utf8'});
  assert.equal(result.status===0,passes,result.stdout+result.stderr);
 }
});

test('publishers copy the scanned OCI graph directly and check the registry digest',()=>{
 for(const name of ['onprem-release']){
  const workflow=readFileSync(join(__dirname,`../workflows/${name}.yml`),'utf8');
  const publish=workflow.match(/^  publish:\n([\s\S]*?)(?=^  [a-z][a-z-]*:|$(?![\s\S]))/m)[1];
  assert.doesNotMatch(publish,/docker (?:load|run|build|import)|zstd|--insecure|--plain-http/);
  assert.ok(publish.includes('oras cp --from-oci-layout'));
  assert.ok(publish.includes('"image@$digest" "$tag"'));
  assert.ok(publish.includes('oras resolve --registry-config'));
  assert.ok(publish.includes('sbom-path: sbom.cdx.json'));
  assert.match(publish,/checksum: [a-f0-9]{64}/);
  assert.ok(publish.includes('$HOME/.docker/config.json'));
  assert.ok(publish.indexOf('Clear registry credentials after signing')>publish.lastIndexOf('uses: actions/attest@'));
  assert.doesNotMatch(publish,/trap 'oras logout/);
 }
});
