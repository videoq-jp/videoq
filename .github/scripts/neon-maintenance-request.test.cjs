const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {requestArgs,runRequest}=require('./neon-maintenance-request.cjs');
const base={GITHUB_REPOSITORY:'videoq-jp/videoq',GITHUB_REF:'refs/heads/main',OPERATION:'audit'};
test('default maintenance requests preserve existing age audit/rotation/recovery selection',()=>{for(const operation of ['audit','rotate','rollback'])assert.deepEqual(requestArgs({...base,OPERATION:operation}),[operation]);});
test('the only special inspection uses fixed audit arguments and refuses rotation or arbitrary values',()=>{
 assert.deepEqual(requestArgs({...base,AUDIT_INSPECTION:'postgres-login-fence'}),['audit','--inspection','postgres-login-fence']);
 for(const change of [{OPERATION:'rotate',AUDIT_INSPECTION:'postgres-login-fence'},{OPERATION:'rollback',AUDIT_INSPECTION:'postgres-login-fence'},{OPERATION:'audit --sql anything'},{AUDIT_INSPECTION:'sql'},{AUDIT_INSPECTION:'postgres-login-fence; command'}])assert.throws(()=>requestArgs({...base,...change}));
});
test('non-main or another repository cannot invoke the request client',()=>{let calls=0;for(const change of [{GITHUB_REF:'refs/heads/test'},{GITHUB_REF:undefined},{GITHUB_REPOSITORY:'other/repository'}])assert.throws(()=>runRequest({env:{...base,...change},execute:()=>{calls++;}}),/PRODUCTION_MAIN_ONLY/);assert.equal(calls,0);});
test('inspection goes through the existing metadata-only Python request client without shell execution',()=>{const calls=[];runRequest({env:{...base,AUDIT_INSPECTION:'postgres-login-fence'},execute:(...args)=>calls.push(args)});assert.deepEqual(calls,[['python3',['.github/scripts/run-aws-db.py','audit','--inspection','postgres-login-fence'],{stdio:'inherit'}]]);});
test('the workflow retains its protected main environment and passes typed input only through environment',()=>{
 const source=fs.readFileSync('.github/workflows/neon-credentials.yml','utf8');assert.ok(source.includes("github.ref == 'refs/heads/main'"));assert.ok(source.includes('environment: production-db-maintenance'));assert.ok(source.includes('options: [none, postgres-login-fence]'));assert.ok(source.includes('AUDIT_INSPECTION: ${{ inputs.audit_inspection }}'));assert.ok(source.includes('run: node .github/scripts/neon-maintenance-request.cjs'));assert.ok(!/run:.*\$\{\{/.test(source));
});
