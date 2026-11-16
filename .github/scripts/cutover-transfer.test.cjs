const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const modulePromise=import('./cutover-transfer.mjs');
test('cutover transfer accepts only fixed modes and complete reviewed-run arguments',async()=>{
 const {parseTransferArguments}=await modulePromise;
 const args=['--run','a'.repeat(32),'--source','b'.repeat(40),'--input','/private/synthetic-archive','--mode','import'];assert.equal(parseTransferArguments(args).mode,'import');
 for(const value of [args.slice(0,6),[...args.slice(0,6),'--mode','production'],['--run','a'.repeat(32),'--run','a'.repeat(32),...args.slice(4)],['--run','bad',...args.slice(2)]])assert.throws(()=>parseTransferArguments(value));
});
test('same-bucket visual destination creates only new immutable chunk/publication keys',async()=>{
 const {immutableProductionVisualDestination}=await modulePromise,calls=[];
 const destination=immutableProductionVisualDestination({read:async()=>null,create:async(key,bytes)=>{calls.push({key,bytes});}}),run=randomUUID(),version=randomUUID(),prefix='videos/synthetic.mp4.visual-v2/'+run+'/';
 for(const key of [prefix+'0/'+version+'.bin',prefix+'0/'+version+'.json',prefix+'publications/'+version+'/manifest.json',prefix+'publications/'+version+'/overview.json'])await destination.create(key,Buffer.from('synthetic'));
 assert.equal(calls.length,4);
 for(const key of ['videos/synthetic.mp4','videos/synthetic.mp4.frames-v1.json','videos/synthetic.mp4.focus-v2.json',prefix+'0.bin',prefix+'0.json',prefix+'publications/manifest.json',prefix+'0/'+version+'.bin/extra'])await assert.rejects(()=>destination.create(key,Buffer.from('must-not-overwrite')),/ONLY_NEW_VERSIONED_VISUAL_KEYS_ALLOWED/);
 assert.equal(calls.length,4);
});
test('GitHub environments cannot invoke the local transfer or reach its transports',async()=>{
 const {main}=await modulePromise;
 await assert.rejects(()=>main({args:['--run','a'.repeat(32),'--source','b'.repeat(40),'--input','/private/synthetic','--mode','import'],env:{GITHUB_ACTIONS:'true'},verifySource:()=>{throw Error('unexpected source call');},aws:()=>{throw Error('unexpected AWS');},github:()=>{throw Error('unexpected GitHub');}}),/LOCAL_REVIEWED_CUTOVER_OPERATOR_REQUIRED/);
});
