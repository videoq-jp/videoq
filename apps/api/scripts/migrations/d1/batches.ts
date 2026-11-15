import type {D1Database,D1PreparedStatement,D1Result} from '@cloudflare/workers-types';
/** Migration-tool batching only. Keep each request bounded; callers decide
 * which writes must be atomic and must not split those units across requests. */
export async function migrationBatches<T=Record<string,unknown>>(database:D1Database,statements:D1PreparedStatement[],size=25){
 if(!Number.isSafeInteger(size)||size<1||size>25)throw new Error('Invalid migration batch size.');
 const results:D1Result<T>[]=[];
 for(let offset=0;offset<statements.length;offset+=size)results.push(...await database.batch<T>(statements.slice(offset,offset+size)));
 return results;
}
