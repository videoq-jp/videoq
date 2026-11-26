import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtemp,writeFile,rm,chmod,symlink,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
vi.mock('wrangler',()=>({getPlatformProxy:vi.fn()}));
import {getPlatformProxy} from 'wrangler';
import {main,parseSearchEvaluationArguments,searchEvaluationEnvironment} from '../../scripts/d1-staging-evaluate-search';
const directories:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();vi.clearAllMocks();await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'videoq-evaluation-cli-'));directories.push(directory);
 const input=join(directory,'cases.json'),output=join(directory,'report.json'),archive=join(directory,'source.videoq-export.ndjson');
 await writeFile(input,JSON.stringify({version:1,cohort:'synthetic',corpusSha256:'a'.repeat(64),model:'text-embedding-3-small',dimensions:1536,samples:1,
  cases:[{queryEmbedding:Array.from({length:1536},(_,i)=>i===0?1:0),userId:'synthetic-owner',videoIds:[1],limit:20}]}),{mode:0o600});
 return {input,output,archive,args:['--input',input,'--output',output,'--archive',archive]};
}
describe('staging search evaluation preflight',()=>{
 it('requires private case, archive and new report paths and forbids target overrides',()=>{
  expect(parseSearchEvaluationArguments(['--input','cases.json','--archive','source.ndjson','--output','report.json']).input).toMatch(/cases.json$/);
  for(const args of [[],['--input','cases'],['--config','production.json'],['--input','a','--input','b','--archive','c','--output','d']])expect(()=>parseSearchEvaluationArguments(args)).toThrow();
 });
 it('accepts preservation evidence only as an explicit paired option',()=>{
  const base=['--input','cases.json','--archive','source.ndjson','--output','report.json'];
  expect(parseSearchEvaluationArguments([...base,'--preserved-policy','policy.json','--backup-dir','backup']).preservation).toEqual({backupDirectory:expect.stringMatching(/backup$/),policyPath:expect.stringMatching(/policy.json$/)});
  for(const extra of [['--preserved-policy','policy.json'],['--backup-dir','backup']])expect(()=>parseSearchEvaluationArguments([...base,...extra])).toThrow();
 });
 it('refuses existing output without modifying it or connecting',async()=>{
  const f=await fixture();await writeFile(f.output,'sentinel');
  await expect(main(f.args)).rejects.toThrow('already exists');
  expect(await readFile(f.output,'utf8')).toBe('sentinel');
  expect(getPlatformProxy).not.toHaveBeenCalled();
 });
 it('refuses public-readable input and input symlinks before connecting',async()=>{
  const f=await fixture();await chmod(f.input,0o644);
  await expect(main(f.args)).rejects.toThrow('Private');
  await chmod(f.input,0o600);const path=f.input+'.link';await symlink(f.input,path);
  await expect(main(['--input',path,'--output',f.output,'--archive',f.archive])).rejects.toThrow('Private');
  expect(getPlatformProxy).not.toHaveBeenCalled();
 });
 it('requires explicit frozen-source assertion, verified remote TLS and matching profile before connecting',async()=>{
  const f=await fixture();vi.stubEnv('PERSISTENCE_EVALUATION_SOURCE_OFFLINE','');
  await expect(main(f.args)).rejects.toThrow('offline');
  vi.stubEnv('PERSISTENCE_EVALUATION_SOURCE_OFFLINE','1');
  vi.stubEnv('DATABASE_URL','postgresql://synthetic:synthetic@database.invalid/test?sslmode=require');
  await expect(main(f.args)).rejects.toThrow('TLS');
  vi.stubEnv('DATABASE_URL','postgresql://synthetic:synthetic@127.0.0.1:1/test');
  vi.stubEnv('EMBEDDING_PROFILE','openai');vi.stubEnv('EMBEDDING_MODEL','different-model');
  await expect(main(f.args)).rejects.toThrow('model/profile');
  expect(getPlatformProxy).not.toHaveBeenCalled();
 });
});

it('preserves explicit embedding identity and endpoints without inventing missing declarations',()=>{
 const source={EMBEDDING_PROVIDER:'openai',EMBEDDING_PROFILE:'embeddinggemma2',EMBEDDING_MODEL:'served-alias',
  EMBEDDING_BASE_URL:'https://private.invalid/v1',OPENAI_BASE_URL:'https://chat.invalid/v1',EMBEDDING_REVISION:'weights-sha256',EMBEDDING_PREPROCESSING:'normalize-v2'};
 expect(searchEvaluationEnvironment('postgresql://readonly/test',source)).toEqual({DATABASE_URL:'postgresql://readonly/test',...source});
 const missing=searchEvaluationEnvironment('postgresql://readonly/test',{});
 for(const key of Object.keys(source))expect(missing[key as keyof typeof missing]).toBeUndefined();
 expect(searchEvaluationEnvironment('postgresql://readonly/test',{...source,EMBEDDING_REVISION:'',EMBEDDING_PREPROCESSING:''})).toMatchObject({EMBEDDING_REVISION:'',EMBEDDING_PREPROCESSING:''});
});
