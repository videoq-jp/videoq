/** Fixed-origin requests and owner-only, serialized, atomic acceptance evidence IO. */
import assert from 'node:assert/strict';
import {constants,openSync,closeSync,fstatSync,readFileSync,writeFileSync,fsyncSync,renameSync,unlinkSync,rmSync,realpathSync,statSync} from 'node:fs';
import {resolve,dirname,basename,join} from 'node:path';
import {randomUUID} from 'node:crypto';
export const acceptanceAccount='12daec56fdba43f677f2766ee26a5a39';
export const acceptanceOrigin='https://videoq-acceptance-20261125-c33d.yukiharada1228.workers.dev';
export function databaseId(value){assert.equal(typeof value,'string');assert(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value),'Invalid fixture database ID');return value;}
export function cloudflareUrl(path){
 assert.equal(typeof path,'string');assert(path.startsWith('/accounts/'+acceptanceAccount+'/'));
 const url=new URL('https://api.cloudflare.com/client/v4'+path);
 assert.equal(url.origin,'https://api.cloudflare.com');assert(url.pathname.startsWith('/client/v4/accounts/'+acceptanceAccount+'/'));assert(!url.hash&&!url.username&&!url.password);return url.href;
}
export function applicationUrl(path){
 assert.equal(typeof path,'string');assert(path.startsWith('/')&&!path.startsWith('//'));const url=new URL(path,acceptanceOrigin);
 assert.equal(url.origin,acceptanceOrigin);assert(!url.username&&!url.password&&!url.hash);return url.href;
}
export async function withPrivateWorkspace(directory,action){
 assert(directory,'ACCEPTANCE_PRIVATE_DIR required');const root=realpathSync(directory),info=statSync(root);assert(info.isDirectory());assert.equal(info.uid,process.getuid());assert.equal(info.mode&0o077,0,'Acceptance directory must be owner-only');
 const lock=join(root,'.acceptance-io.lock');const lockFd=openSync(lock,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 const path=name=>{assert(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name),'Expected a workspace basename');return join(root,name);};
 const workspace={root,path,
  outputName(input,fallback){if(!input)return fallback;assert.equal(realpathSync(dirname(resolve(input))),root,'Report must remain within private workspace');const name=basename(input);path(name);return name;},
  read(name,{optional=false}={}){let fd;try{fd=openSync(path(name),constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if(optional&&error.code==='ENOENT')return undefined;throw error;}try{const metadata=fstatSync(fd);assert(metadata.isFile()&&metadata.uid===process.getuid()&&metadata.size<=128*1024*1024,'Invalid acceptance input file');return readFileSync(fd,'utf8');}finally{closeSync(fd);}},
  write(name,data){const target=path(name),temporary=join(root,'.acceptance-'+randomUUID()+'.tmp');let fd;try{fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,data);fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temporary,target);}finally{if(fd!==undefined)closeSync(fd);rmSync(temporary,{force:true});}},
  reserve(name){const fd=openSync(path(name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);closeSync(fd);return path(name);},
 };
 try{return await action(workspace);}finally{closeSync(lockFd);unlinkSync(lock);}
}
