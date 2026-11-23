'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const wrapper = path.join(__dirname,'terraform-r2.cjs');
test('backend credentials never replace AWS provider credentials or reach argv',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tf-r2-test-'));
  try {
    const binary=path.join(directory,'terraform');
    fs.writeFileSync(binary,`#!/usr/bin/env node
const fs=require('node:fs');
const assert=require('node:assert/strict');
assert.equal(process.env.AWS_ACCESS_KEY_ID,undefined);
assert.equal(process.env.AWS_SECRET_ACCESS_KEY,undefined);
assert.equal(process.env.AWS_SESSION_TOKEN,undefined);
assert.equal(process.env.TF_STATE_R2_SECRET_ACCESS_KEY,undefined);
assert.equal(process.env.AWS_PROFILE,'videoq-aws-provider');
assert.equal(fs.statSync(process.env.AWS_SHARED_CREDENTIALS_FILE).mode & 0o777,0o600);
const value=fs.readFileSync(process.env.AWS_SHARED_CREDENTIALS_FILE,'utf8');
assert.match(value,/\\[videoq-r2-state\\]\\naws_access_key_id=R2KEY\\naws_secret_access_key=R2SECRET/);
assert.match(value,/\\[videoq-aws-provider\\]\\naws_access_key_id=AWSKEY\\naws_secret_access_key=AWSSECRET\\naws_session_token=SESSION/);
console.log(process.env.AWS_SHARED_CREDENTIALS_FILE);
`,{mode:0o700});
    const result=spawnSync(process.execPath,[wrapper,'version'],{encoding:'utf8',env:{...process.env,TERRAFORM_BINARY:binary,AWS_SHARED_CREDENTIALS_FILE:path.join(directory,'absent'),AWS_ACCESS_KEY_ID:'AWSKEY',AWS_SECRET_ACCESS_KEY:'AWSSECRET',AWS_SESSION_TOKEN:'SESSION',TF_STATE_R2_ACCESS_KEY_ID:'R2KEY',TF_STATE_R2_SECRET_ACCESS_KEY:'R2SECRET'}});
    assert.equal(result.status,0,result.stderr);
    assert.equal(fs.existsSync(result.stdout.trim()),false,'temporary credentials must be removed');
    assert.doesNotMatch(result.stdout+result.stderr,/AWSSECRET|R2SECRET|SESSION/);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
test('missing R2 credentials fail before Terraform can run',()=>{
  const env={...process.env};delete env.TF_STATE_R2_ACCESS_KEY_ID;delete env.TF_STATE_R2_SECRET_ACCESS_KEY;
  const result=spawnSync(process.execPath,[wrapper,'apply'],{env,encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,/R2 state credentials are required/);
});
