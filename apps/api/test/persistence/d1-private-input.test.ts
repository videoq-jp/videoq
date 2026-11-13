import {mkdtemp,writeFile,readFile,rm,chmod,symlink,rename,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,describe,it,expect} from 'vitest';
import {openPrivateInput,readPrivateInput,copyPrivateInput} from '../../scripts/migrations/d1/private-input';
describe('private migration inputs',()=>{
 let directory:string,input:string;
 beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'videoq-private-input-'));input=join(directory,'input');await writeFile(input,'original',{mode:0o600});});
 afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
 it('reads and copies private files with exact bounds and exclusive publication',async()=>{
  expect((await readPrivateInput(input,8)).toString()).toBe('original');
  const output=join(directory,'copy');await copyPrivateInput(input,output,8);
  expect(await readFile(output,'utf8')).toBe('original');expect(await privateMode(output)&0o777).toBe(0o600);
  await expect(copyPrivateInput(input,output,8)).rejects.toThrow();expect(await readFile(output,'utf8')).toBe('original');
 });
 it('preserves empty plans when copying while bounded JSON readers reject them',async()=>{
  await writeFile(input,'');const output=join(directory,'empty-plan');await copyPrivateInput(input,output);
  expect(await readFile(output,'utf8')).toBe('');await expect(readPrivateInput(input,8)).rejects.toThrow('Private');
 });
 it('keeps the validated inode when the source path is replaced',async()=>{
  const {file}=await openPrivateInput(input,8);
  try{await rename(input,input+'.old');await writeFile(input,'replaced',{mode:0o600});expect(await file.readFile('utf8')).toBe('original');}
  finally{await file.close();}
 });
 it('rejects symlinks, public permissions, empty, oversized and missing inputs',async()=>{
  const link=input+'.link';await symlink(input,link);await expect(readPrivateInput(link,8)).rejects.toThrow('Private');
  await expect(readPrivateInput(input,7)).rejects.toThrow('Private');
  await chmod(input,0o644);await expect(readPrivateInput(input,8)).rejects.toThrow('Private');
  await chmod(input,0o600);await writeFile(input,'');await expect(readPrivateInput(input,8)).rejects.toThrow('Private');
  await expect(readPrivateInput(input+'.missing',8)).rejects.toThrow('Private');
 });
 it('does not publish a rejected source or change an existing destination',async()=>{
  const output=join(directory,'copy');await writeFile(output,'sentinel',{mode:0o600});await chmod(input,0o644);
  await expect(copyPrivateInput(input,output)).rejects.toThrow('Private');expect(await readFile(output,'utf8')).toBe('sentinel');
 });
});

async function privateMode(path:string){const file=await open(path,'r');try{return (await file.stat()).mode;}finally{await file.close();}}
