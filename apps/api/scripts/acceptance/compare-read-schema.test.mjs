import {test}from'node:test';import assert from'node:assert/strict';
import{compareReadSchema}from'./compare-read-schema.mjs';
const expected=[{type:'table',name:'a',tbl_name:'a',sql:'CREATE TABLE a (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES a(id), value TEXT NOT NULL DEFAULT 1)'},{type:'index',name:'idx',tbl_name:'a',sql:'CREATE INDEX idx ON a(lower(value))'},{type:'trigger',name:'trg',tbl_name:'a',sql:'CREATE TRIGGER trg AFTER INSERT ON a BEGIN UPDATE a SET value=2; END'}];
test('only documented provider table is excluded; exact application definitions preserve all constraints/expressions/trigger semantics',()=>{
 const provider={type:'table',name:'_cf_KV',tbl_name:'_cf_KV',sql:'CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID'};
 assert.equal(compareReadSchema(expected,[...expected,provider]).passed,true);
 for(let i=0;i<expected.length;i++){const changed=structuredClone(expected);changed[i].sql+=' ';assert.equal(compareReadSchema(expected,changed).passed,false);}
 assert.equal(compareReadSchema(expected,[...expected,{...provider,name:'_cf_unknown',tbl_name:'_cf_unknown'}]).passed,false);
 assert.equal(compareReadSchema(expected,expected.slice(1)).passed,false);
});
