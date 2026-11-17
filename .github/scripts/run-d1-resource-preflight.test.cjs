const {test}=require('node:test'),assert=require('node:assert/strict');
const {parse,cloudflareToken,main}=require('./run-d1-resource-preflight.cjs');
const sha='a'.repeat(40),token='synthetic-cloudflare-token-0123456789';
test('read-only CLI accepts exact source and optional project digest, never token/force/action arguments',()=>{
 assert.deepEqual(parse(['--source',sha]),{source:sha,expectedProjectSha256:undefined});assert.equal(parse(['--project-sha256','b'.repeat(64),'--source',sha]).expectedProjectSha256,'b'.repeat(64));
 for(const args of [[],['--source',sha,'--source',sha],['--source',sha,'--token',token],['--source',sha,'--action','advance'],['--source','other']])assert.throws(()=>parse(args));
});
test('Wrangler credential retrieval is captured in memory with isolated environment and no install/login fallback',()=>{
 const calls=[];assert.equal(cloudflareToken({env:{PATH:'fixture',HOME:'fixture',VIDEOQ_WRANGLER_BIN:'/approved/wrangler',GH_TOKEN:'github-only',AWS_ACCESS_KEY_ID:'aws-only',NODE_OPTIONS:'forbidden'},execute:(program,args,options)=>{
  calls.push(args);assert.equal(program,'/approved/wrangler');assert.equal(options.env.AWS_ACCESS_KEY_ID,undefined);assert.equal(options.env.GH_TOKEN,undefined);assert.equal(options.env.NODE_OPTIONS,undefined);assert.deepEqual(options.stdio,['ignore','pipe','pipe']);return args[0]==='--version'?'4.156.1\n':JSON.stringify({type:'oauth',token});
 }}),token);assert.deepEqual(calls,[['--version'],['auth','token','--json']]);
 for(const value of ['PRIVATE_AUTH_BODY',JSON.stringify({type:'api_key',key:'PRIVATE_KEY'}),JSON.stringify({type:'oauth',token:'short'})])assert.throws(()=>cloudflareToken({env:{VIDEOQ_WRANGLER_BIN:'/approved/wrangler'},execute:(_p,args)=>args[0]==='--version'?'4.156.1':value}),{message:'RESOURCE_PREFLIGHT_AUTH_REQUIRED'});
});
test('explicit bearer token avoids child execution and malformed tokens never reach a command',()=>{
 assert.equal(cloudflareToken({env:{CLOUDFLARE_API_TOKEN:token},execute:()=>assert.fail('command ran')}),token);
 assert.throws(()=>cloudflareToken({env:{CLOUDFLARE_API_TOKEN:token+'\n'},execute:()=>assert.fail('command ran')}),/AUTH_REQUIRED/);
});
test('dirty source fails before credential retrieval, AWS or Cloudflare; CI context refuses all execution',async()=>{
 let auth=0,requests=0;const execute=(program,args)=>{if(program!=='git'){auth++;throw Error('must not run');}if(args[0]==='status')return' M tracked.cjs\n';return sha+'\n';};
 await assert.rejects(main({args:['--source',sha],env:{},execute,fetcher:async()=>requests++}),/CLEAN_CANONICAL/);assert.equal(auth,0);assert.equal(requests,0);
 await assert.rejects(main({args:['--source',sha],env:{GITHUB_ACTIONS:'true'},execute:()=>assert.fail('command ran')}),/LOCAL_CONTEXT/);
});
