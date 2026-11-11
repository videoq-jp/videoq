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
if [ "$1" = load ]; then cat >/dev/null; exit 0; fi
if [ "$1 $2" = "$TEST_FAILURE" ]; then exit 7; fi
case "$1 $2" in
  'buildx build') mkdir -p "$RUNNER_TEMP/scan-image"; touch "$RUNNER_TEMP/scan-image/proof" ;;
  'create '* ) printf 'container-id\\n' ;;
  'cp '* ) tar -c -C "$TEST_DIRECTORY" image-license ;;
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

test('image pipeline releases build layers before loading and checks the actual shipped license',()=>{
 const result=runBuild();
 assert.equal(result.status,0,result.stderr);
 assert.ok(result.commands.indexOf('buildx prune')<result.commands.indexOf('load\n'));
 assert.ok(result.commands.includes('cp container-id:/usr/share/licenses/videoq/LICENSE -'));
 assert.ok(result.commands.includes('image rm fixture:ci'));
});

test('a build failure prevents loading, and a license mismatch prevents successful handoff',()=>{
 const failed=runBuild({failure:'buildx build'});
 assert.equal(failed.status,7);
 assert.ok(!failed.commands.includes('load\n'));
 const mismatch=runBuild({mismatchedLicense:true});
 assert.notEqual(mismatch.status,0);
 assert.ok(!mismatch.commands.includes('image rm fixture:ci'));
 assert.ok(mismatch.commands.includes('rm -f container-id'));
});

test('one complete strict scan supplies both the inventory and the separate publisher',()=>{
 assert.equal([...action.matchAll(/uses: aquasecurity\/trivy-action@/g)].length,1);
 for(const setting of ["ignore-unfixed: 'false'",'severity: HIGH,CRITICAL',"exit-code: '1'","list-all-pkgs: 'true'"])
  assert.ok(action.includes(setting),setting);
 assert.ok(action.includes('trivy convert --format cyclonedx --output artifact/sbom.cdx.json artifact/security.json'));
 assert.doesNotMatch(action,/trivy image |docker save|continue-on-error|secrets\./);
 assert.ok(action.indexOf('configure-onprem-ci-dns.py --docker --oci')<action.indexOf('docker load'));
 assert.ok(action.indexOf('uses: aquasecurity/trivy-action@')<action.indexOf('zstd -T0'));
 assert.ok(action.includes("if: inputs.artifact-name != ''"));
 for(const name of ['onprem-validation','onprem-release','onprem-runtime-base']){
  const workflow=readFileSync(join(__dirname,`../workflows/${name}.yml`),'utf8');
  assert.ok(workflow.includes('uses: ./.github/actions/build-onprem-image'),name);
  assert.doesNotMatch(workflow,/docker buildx build|scan-image.tar/,name);
 }
 for(const match of action.matchAll(/uses: [^@\n]+@(\S+)/g)) assert.match(match[1],/^[a-f0-9]{40}$/);
});


test('image-action changes select GPU validation without selecting unrelated app jobs',()=>{
 const workflow=readFileSync(join(__dirname,'../workflows/ci.yml'),'utf8');
 const filter=name=>workflow.match(new RegExp(`^            ${name}:\\n([\\s\\S]*?)(?=^            \\w+:|^      - name:)`,'m'))[1];
 assert.ok(filter('whisper_gpu').includes("'.github/actions/build-onprem-image/**'"));
 for(const name of ['containers','hono','worker','frontend','docs']){
  assert.doesNotMatch(filter(name),/['"]\.github\/actions\/\*\*['"]/);
  assert.ok(filter(name).includes('.github/actions/setup-package-manager/**'),name);
 }
});
