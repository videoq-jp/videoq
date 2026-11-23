#!/usr/bin/env node
'use strict';
// Keep the S3-compatible backend credentials separate from AWS provider credentials.
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const BUCKET = 'videoq-terraform-state-prod';
const HOST = '12daec56fdba43f677f2766ee26a5a39.r2.cloudflarestorage.com';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();

async function archiveState(state, key, env) {
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const objectKey = `history/${key}/${date}-${crypto.randomUUID()}-${hash(state)}.json`;
  const uri = '/' + [BUCKET, ...objectKey.split('/')].map(encodeURIComponent).join('/');
  const headers = {'content-type':'application/json',host:HOST,'if-none-match':'*',
    'x-amz-content-sha256':hash(state),'x-amz-date':date};
  const names = Object.keys(headers).sort();
  const canonical = `PUT\n${uri}\n\n${names.map(n=>`${n}:${headers[n]}\n`).join('')}\n${names.join(';')}\n${hash(state)}`;
  const scope = `${date.slice(0,8)}/auto/s3/aws4_request`;
  const signing = hmac(hmac(hmac(hmac('AWS4'+env.TF_STATE_R2_SECRET_ACCESS_KEY,date.slice(0,8)),'auto'),'s3'),'aws4_request');
  const signature = hmac(signing,`AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).toString('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${env.TF_STATE_R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  const response = await fetch(`https://${HOST}${uri}`, {method:'PUT',headers,body:state,redirect:'error',signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`State recovery snapshot failed (HTTP ${response.status}); apply was not started`);
}

async function main() {
  const args = process.argv.slice(2);
  const env = {...process.env};
  if (!env.TF_STATE_R2_ACCESS_KEY_ID || !env.TF_STATE_R2_SECRET_ACCESS_KEY) throw new Error('R2 state credentials are required');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'videoq-terraform-'));
  try {
    let credentials = '';
    const originalFile = env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(),'.aws','credentials');
    if (fs.existsSync(originalFile)) credentials = fs.readFileSync(originalFile,'utf8');
    if (/^\[videoq-r2-state\]$/m.test(credentials)) throw new Error('Reserved backend profile already exists in shared credentials');
    credentials += `\n[videoq-r2-state]\naws_access_key_id=${env.TF_STATE_R2_ACCESS_KEY_ID}\naws_secret_access_key=${env.TF_STATE_R2_SECRET_ACCESS_KEY}\n`;
    if (env.AWS_ACCESS_KEY_ID || env.AWS_SECRET_ACCESS_KEY) {
      if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw new Error('Incomplete AWS provider credentials');
      credentials += `\n[videoq-aws-provider]\naws_access_key_id=${env.AWS_ACCESS_KEY_ID}\naws_secret_access_key=${env.AWS_SECRET_ACCESS_KEY}\n`;
      if (env.AWS_SESSION_TOKEN) credentials += `aws_session_token=${env.AWS_SESSION_TOKEN}\n`;
      env.AWS_PROFILE = 'videoq-aws-provider';
    }
    env.AWS_SHARED_CREDENTIALS_FILE = path.join(directory,'credentials');
    fs.writeFileSync(env.AWS_SHARED_CREDENTIALS_FILE,credentials,{mode:0o600});
    for (const key of ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_SECURITY_TOKEN','TF_STATE_R2_ACCESS_KEY_ID','TF_STATE_R2_SECRET_ACCESS_KEY']) delete env[key];
    if (env.CLOUDFLARE_API_TOKEN) env.TF_VAR_cloudflare_api_token = env.CLOUDFLARE_API_TOKEN;
    const binary = process.env.TERRAFORM_BINARY || 'terraform';
    const command = args.find(arg=>!arg.startsWith('-'));
    if (['apply','destroy'].includes(command)) {
      const cwdArgs = args.filter(arg=>arg.startsWith('-chdir='));
      const backendFile = path.resolve(cwdArgs[0]?.slice(7) || '.', '.terraform/terraform.tfstate');
      const backend = JSON.parse(fs.readFileSync(backendFile,'utf8')).backend;
      if (backend.type !== 's3' || backend.config.bucket !== BUCKET || backend.config.endpoints.s3 !== `https://${HOST}`) throw new Error('Apply requires the verified VideoQ R2 backend');
      const pulled = spawnSync(binary,[...cwdArgs,'state','pull'],{env,encoding:'utf8',maxBuffer:64*1024*1024});
      if (pulled.status !== 0) throw new Error('Cannot read the current state for recovery; apply was not started');
      JSON.parse(pulled.stdout);
      await archiveState(pulled.stdout,backend.config.key,process.env);
      console.log('Saved immutable recovery state before apply.');
    }
    const result = spawnSync(binary,args,{env,stdio:'inherit'});
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(directory,{recursive:true,force:true});
  }
}
if (require.main === module) main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports = {archiveState};
