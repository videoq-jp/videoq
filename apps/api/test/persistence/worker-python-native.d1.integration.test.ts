import {it,expect} from 'vitest';
import {build} from 'esbuild';
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {connect} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {createD1Fixture} from './d1-fixture';
const exec=promisify(execFile),apiRoot=fileURLToPath(new URL('../../',import.meta.url)),workerRoot=fileURLToPath(new URL('../../../worker/',import.meta.url));
const python=existsSync(join(workerRoot,'.venv/bin/python'))?join(workerRoot,'.venv/bin/python'):'python3';

it('persists real Python-signed HTTPS calls in native workerd, retaining pending vector delivery',async()=>{
 const temporary=await mkdtemp(join(tmpdir(),'videoq-native-worker-'));let fixture:Awaited<ReturnType<typeof createD1Fixture>>|undefined;
 try{
  const key=join(temporary,'key.pem'),cert=join(temporary,'cert.pem'),ca=join(temporary,'ca.pem'),caKey=join(temporary,'ca-key.pem'),csr=join(temporary,'server.csr'),extensions=join(temporary,'extensions.cnf'),config=join(temporary,'openssl.cnf');
  await writeFile(config,'[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=localhost\n');
  await exec('openssl',['req','-config',config,'-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=VideoQ test CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign','-addext','subjectKeyIdentifier=hash','-addext','authorityKeyIdentifier=keyid:always,issuer','-keyout',caKey,'-out',ca],{timeout:15000});
  await exec('openssl',['req','-config',config,'-new','-newkey','rsa:2048','-nodes','-subj','/CN=localhost','-keyout',key,'-out',csr],{timeout:15000});
  await writeFile(extensions,'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n');
  await exec('openssl',['x509','-req','-in',csr,'-CA',ca,'-CAkey',caKey,'-CAcreateserial','-days','1','-extfile',extensions,'-out',cert],{timeout:15000});
  await exec('openssl',['verify','-CAfile',ca,cert],{timeout:15000});
  const bundle=await build({absWorkingDir:apiRoot,entryPoints:['test/helpers/worker-internal-native-entry.ts'],bundle:true,write:false,format:'esm',platform:'node',target:'es2022',external:['cloudflare:*','node:*','pg-native'],banner:{js:`import {createRequire} from "node:module";const require=createRequire("/worker.mjs");`}});
  const secret=crypto.randomUUID()+crypto.randomUUID();
  fixture=await createD1Fixture({worker:{script:bundle.outputFiles[0].text,bindings:{DEPLOYMENT_EDITION:'cloud',WORKER_INTERNAL_API_SECRET:secret},httpsKey:await readFile(key,'utf8'),httpsCert:await readFile(cert,'utf8')}});
  const db=fixture.database;
  await db.prepare("INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes) VALUES('owner','owner','native@example.invalid',0,0,0,0)").run();
  await db.prepare("INSERT INTO videos(id,user_id,title,file,status,transcript,description,uploaded_at,error_message,source_type,source_url,youtube_video_id) VALUES(1,'owner','Native worker','native.mp4','pending','','','2026-11-14T00:00:00.000Z','','uploaded','','')").run();
  expect(fixture.origin).toMatch(/^https:\/\/127\.0\.0\.1:/);
  const address=new URL(fixture.origin!),certificate=await readFile(cert,'utf8'),authority=await readFile(ca,'utf8');
  await new Promise<void>((resolve,reject)=>{
   const socket=connect({host:address.hostname,port:Number(address.port),ca:authority,rejectUnauthorized:true},()=>{
    try{expect(socket.getPeerCertificate().fingerprint256).toBe(new X509Certificate(certificate).fingerprint256);socket.end();resolve();}catch(error){socket.destroy();reject(error instanceof Error?error:new Error('TLS assertion failed'));}
   });socket.once('error',reject);socket.setTimeout(5000,()=>socket.destroy(new Error('Local TLS handshake timed out')));
  });
  const response=await exec(python,[join(apiRoot,'test/helpers/worker-internal-native-client.py')],{cwd:workerRoot,timeout:60000,maxBuffer:65536,env:{PATH:process.env.PATH,PYTHONPATH:workerRoot,SSL_CERT_FILE:ca,NO_PROXY:'127.0.0.1,localhost',DEPLOYMENT_EDITION:'cloud',PERSISTENCE_BACKEND:'d1',WORKER_INTERNAL_API_ORIGIN:fixture.origin!,WORKER_INTERNAL_API_SECRET:secret}});
  expect(JSON.parse(response.stdout)).toEqual({python_https_native_persistence_verified:true,vector_delivery_pending:true,model_invoked:false,external_queue_invoked:false});
  expect(await db.prepare("SELECT transcript,status FROM videos WHERE id=1").first()).toEqual({transcript:'署名付き字幕 🌸',status:'indexing'});
  expect(await db.prepare("SELECT used_processing_seconds FROM users WHERE id='owner'").first('used_processing_seconds')).toBe(20);
  expect(await db.prepare('SELECT count(*) AS n FROM scenes').first('n')).toBe(1);
  expect(await db.prepare("SELECT count(*) AS n FROM scene_index_tasks WHERE operation='upsert' AND completed_at IS NULL").first('n')).toBe(1);
  expect(await db.prepare('SELECT count(*) AS n FROM external_tasks').first('n')).toBe(1);
  expect(await db.prepare("SELECT status,attempts FROM job_executions WHERE job_id='native-job'").first()).toEqual({status:'completed',attempts:2});
  expect(await db.prepare("SELECT count(*) AS n FROM job_executions WHERE job_id='unsigned-job'").first('n')).toBe(0);
  expect(fixture.outboundRequests()).toBe(0);
 }finally{await fixture?.dispose();await rm(temporary,{recursive:true,force:true});}
},90000);
