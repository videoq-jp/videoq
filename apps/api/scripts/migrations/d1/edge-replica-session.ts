import type {D1Database} from '@cloudflare/workers-types';
import type {EdgeBenchmarkInput} from './edge-benchmark';
/** Benchmark only. Establish ownership on the primary before allowing replica
 * reads at or after that authorization bookmark. Never expose the bookmark. */
export async function bookmarkedReplicaSession(database:Pick<D1Database,'withSession'>,input:EdgeBenchmarkInput,now=()=>performance.now()){
 const start=now(),primary=database.withSession('first-primary');
 const results=await primary.batch<{id:number}>(input.cases.map(request=>primary.prepare('SELECT id FROM videos WHERE id=? AND user_id=?').bind(request.videoId,request.userId)));
 if(results.length!==input.cases.length||results.some((result,index)=>result.results.length!==1||result.results[0].id!==input.cases[index].videoId))throw new Error('PRIMARY_OWNERSHIP_REQUIRED');
 const bookmark=primary.getBookmark();if(!bookmark)throw new Error('PRIMARY_AUTHORIZATION_BOOKMARK_REQUIRED');
 return {session:database.withSession(bookmark),primaryAuthorizationMs:now()-start};
}
