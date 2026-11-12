const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync,readdirSync}=require('node:fs');
const {join}=require('node:path');

test('every host APT/browser dependency job configures CI DNS before installing packages',()=>{
 let checked=0;
 for(const file of readdirSync(join(__dirname,'../workflows')).filter(name=>name.endsWith('.yml'))){
   const workflow=readFileSync(join(__dirname,'../workflows',file),'utf8');
   for(const match of workflow.matchAll(/^  ([a-z][a-z0-9_-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9_-]*:|$(?![\s\S]))/gm)){
     const [_,name,job]=match;
     const install=job.search(/sudo apt-get (?:update|install)|playwright[^\n]*install --with-deps/);
     if(install<0) continue;
     const configure=job.indexOf('run: python3 .github/scripts/configure-onprem-ci-dns.py');
     assert(configure>=0 && configure<install,`${file}/${name} must configure DNS before host package downloads`);
     if(/^    services:/m.test(job)) assert.doesNotMatch(job,/configure-onprem-ci-dns\.py --docker/,`${file}/${name} must retain service containers`);
     checked++;
   }
 }
 assert(checked>=7,`Expected the shared application and on-prem dependency jobs; checked ${checked}`);
});
