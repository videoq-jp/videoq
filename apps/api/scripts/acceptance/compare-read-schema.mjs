/** Conservative catalog comparison: only the specifically evidenced Cloudflare _cf_KV table is provider-owned. */
import assert from 'node:assert/strict';
export function compareReadSchema(expected,actual){
 const key=row=>row.type+':'+row.name;
 const expectedMap=new Map(expected.map(row=>[key(row),row]));
 const extras=actual.filter(row=>!expectedMap.has(key(row)));
 const allowed=extras.filter(row=>row.type==='table'&&row.name==='_cf_KV'&&row.tbl_name==='_cf_KV');
 const unexpected=extras.filter(row=>!allowed.includes(row));
 const actualMap=new Map(actual.filter(row=>!allowed.includes(row)).map(row=>[key(row),row]));
 const differences=[];
 for(const [name,row]of expectedMap){const found=actualMap.get(name);if(!found)differences.push({name,kind:'missing'});else if(row.tbl_name!==found.tbl_name||row.sql!==found.sql)differences.push({name,kind:'definition',expected:row,actual:found});}
 for(const row of unexpected)differences.push({name:key(row),kind:'unexpected',actual:row});
 return {passed:differences.length===0,differences,providerInternalExcluded:allowed,applicationObjectsCompared:expected.length};
}
export function assertReadSchema(result){assert.equal(result.passed,true,'Application schema differs: private catalog diff retained');}
