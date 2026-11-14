/** Locale-independent literal substring matching, shared by both SQL dialects.
 * Keep this separate from identity/email normalization: it grants no authority.
 */
export function literalSearchMatcher(query:string){
 const needle=query.toLowerCase();
 return (...fields:readonly (string|null)[])=>fields.some(field=>field!==null&&field.toLowerCase().includes(needle));
}

/** Scan only searchable fields with a primary-key cursor. Memory is bounded by
 * one source page and the requested result IDs, regardless of the match count.
 * A maintained search projection may replace the scan without changing callers.
 */
export async function literalSearchPage<T extends {id:string}>(
 query:string,limit:number,offset:number,
 page:(after:string|null)=>Promise<T[]>,fields:(row:T)=>readonly (string|null)[],
){
 const matches=literalSearchMatcher(query),ids:string[]=[];let count=0,after:string|null=null;
 for(;;){
  const rows=await page(after);if(!rows.length)break;
  for(const row of rows)if(matches(...fields(row))){if(count>=offset&&ids.length<limit)ids.push(row.id);count++;}
  const next=rows[rows.length-1].id;
  if(next===after)throw new Error('Search cursor did not advance.');
  after=next;
 }
 return {count,ids};
}
