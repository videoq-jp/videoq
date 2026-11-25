/** Redacts provider SQL text/bound literals while retaining authoritative aggregate metrics. */
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('private insights and public output required');
const rows=JSON.parse(readFileSync(input,'utf8'));if(!Array.isArray(rows))throw Error('Unexpected insights shape');
const allowed=['avgRowsRead','totalRowsRead','avgRowsWritten','totalRowsWritten','avgDurationMs','totalDurationMs','numberOfTimesRun','queryEfficiency'];
const sanitized=rows.map(row=>{if(typeof row.query!=='string'||allowed.some(key=>row[key]!==undefined&&typeof row[key]!=='number'))throw Error('Unexpected insights row');return {sqlSha256:createHash('sha256').update(row.query).digest('hex'),...Object.fromEntries(allowed.filter(key=>row[key]!==undefined).map(key=>[key,row[key]]))};});
writeFileSync(output,JSON.stringify({observedAt:new Date().toISOString(),provider:'Cloudflare D1 Insights',window:'previous two hours, hourly analytics; dedicated fixture only',selection:'20 queries sorted by total duration; includes setup/recovery/maintenance, not per-RAG attribution',rows:sanitized,limits:['Top query subset, not total account/database read count','Analytics ingestion delay and hour-bucket boundaries apply','Provider SQL may normalize text differently from application SQL hashes']},null,2)+'\n');
console.log(JSON.stringify({output,queries:sanitized.length}));
