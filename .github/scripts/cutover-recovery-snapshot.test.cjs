'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createHash}=require('node:crypto');
const {normalizeRecoveryRow,frozenTableDigests}=require('./cutover-recovery-snapshot.cjs');
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
test('paged SQLite BLOB projection equals compact private rows without retaining numeric arrays',async()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE conversation_checkpoint_writes(id INTEGER PRIMARY KEY,value BLOB,extra TEXT)');
  const expected=[];for(let i=0;i<61;i++){const bytes=i%3===0?null:Buffer.alloc(i===1?1800000:32768,i);db.prepare('INSERT INTO conversation_checkpoint_writes VALUES(?,?,?)').run(i,bytes,'preserved');expected.push({id:i,value:bytes===null?null:{hex:bytes.toString('hex')},extra:'preserved'});}
  let pages=0;const actual=await frozenTableDigests(async sql=>{if(sql.startsWith('SELECT')){assert.match(sql,/LIMIT 1 OFFSET /);assert.ok(!sql.includes('SELECT *'));pages++;}return{results:db.prepare(sql).all()};},'conversation_checkpoint_writes',hash);
  assert.equal(pages,62);assert.deepEqual(actual,expected.map(hash).sort());
 }finally{db.close();}
});
test('legacy byte-array snapshots normalize to the same strict compact representation',()=>{
 assert.deepEqual(normalizeRecoveryRow('conversation_checkpoints',{checkpoint:[0,128,255],metadata:null}),{checkpoint:{hex:'0080ff'},metadata:null});
 for(const value of [[-1],[256],[0.5],{hex:'abZ1'},{hex:'a'},{hex:'aa',unexpected:true}])assert.throws(()=>normalizeRecoveryRow('conversation_checkpoint_writes',{value}));
});
test('oversized table and unsafe schema fail closed before authorizing recovery',async()=>{
 await assert.rejects(()=>frozenTableDigests(async()=>({results:[{name:'bad"column'}]}),'users',hash));
 await assert.rejects(()=>frozenTableDigests(async sql=>({results:sql.startsWith('PRAGMA')?[{name:'id'}]:Array.from({length:25},(_,id)=>({id}))}),'users',hash));
});
