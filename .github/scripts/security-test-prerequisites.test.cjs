const {test}=require('node:test');const assert=require('node:assert/strict');const {readFileSync}=require('node:fs');
test('security numerical tests retain hash-locked canonical Python prerequisite',()=>{
 const workflow=readFileSync('.github/workflows/ci.yml','utf8').split('  workflow-security:')[1].split('  ci-success:')[0];
 assert.match(workflow,/python-version-file: \.python-version/);
 const install=workflow.indexOf('python3 -m pip install --require-hashes --only-binary=:all: -r .github/scripts/security-test-requirements.txt');
 assert(install>workflow.indexOf('actions/setup-python@'));
 assert(workflow.indexOf('python3 -m unittest discover',install)>install);
 const requirements=readFileSync('.github/scripts/security-test-requirements.txt','utf8');
 const lock=readFileSync('apps/worker/uv.lock','utf8').split('name = "numpy"')[1].split('[[package]]')[0];
 const version=/version = "([^"]+)"/.exec(lock)[1];assert(requirements.includes('numpy=='+version+' '));
 const actual=[...requirements.matchAll(/--hash=sha256:([a-f0-9]{64})/g)].map(m=>m[1]).sort();
 const expected=[...lock.matchAll(/url = "[^"]+\.whl", hash = "sha256:([a-f0-9]{64})"/g)].map(m=>m[1]).sort();
 assert(expected.length>0);assert.deepEqual(actual,[...new Set(expected)]);
});
