import {it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {resolveEmbeddingConfig,embeddingDimensions} from '../src/lib/embedding-contract';
it('actual compose dev script forwards explicit identity/profile and leaves missing identity empty',()=>{
 const directory=mkdtempSync(tmpdir()+'/videoq-dev-env-');
 try{
  mkdirSync(directory+'/apps/api/scripts',{recursive:true});mkdirSync(directory+'/node_modules/.bin',{recursive:true});mkdirSync(directory+'/bin');
  copyFileSync(new URL('../scripts/docker-dev.sh',import.meta.url),directory+'/apps/api/scripts/docker-dev.sh');
  for(const file of ['package-lock.json','node_modules/.videoq-package-lock'])writeFileSync(directory+'/'+file,'same-lock');
  for(const file of ['node_modules/.bin/wrangler','bin/node','bin/npx'])writeFileSync(directory+'/'+file,'#!/bin/sh\nexit 0\n',{mode:0o755});
  const run=(settings:Record<string,string>)=>{
   execFileSync('/bin/sh',[directory+'/apps/api/scripts/docker-dev.sh'],{env:{PATH:directory+'/bin:/usr/bin:/bin',...settings},stdio:'pipe'});
   return Object.fromEntries(readFileSync(directory+'/apps/api/.dev.vars','utf8').trim().split('\n').map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));
  };
  const explicit={EMBEDDING_PROVIDER:'openai',EMBEDDING_PROFILE:'embeddinggemma2',EMBEDDING_MODEL:'served-alias',EMBEDDING_BASE_URL:'http://embedding:8000/v1',EMBEDDING_API_KEY:'synthetic',EMBEDDING_REVISION:'sha256:immutable',EMBEDDING_PREPROCESSING:'normalize-v2',OPENAI_BASE_URL:'http://chat:8000/v1'};
  const actual=run(explicit);expect(actual).toMatchObject(explicit);expect(resolveEmbeddingConfig(actual)).toEqual(resolveEmbeddingConfig(explicit));expect(embeddingDimensions(resolveEmbeddingConfig(actual))).toBe(768);
  const absent=run({});for(const key of ['EMBEDDING_PROVIDER','EMBEDDING_PROFILE','EMBEDDING_REVISION','EMBEDDING_PREPROCESSING'])expect(absent[key]).toBe('');
  expect(embeddingDimensions(resolveEmbeddingConfig(absent))).toBe(1536);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
