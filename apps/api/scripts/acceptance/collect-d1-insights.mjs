/** Exact, bounded read-only provider window; never publishes raw SQL or credentials. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const directory=process.env.ACCEPTANCE_PRIVATE_DIR;if(!directory)throw Error('ACCEPTANCE_PRIVATE_DIR required');
const config=JSON.parse(readFileSync(directory+'/wrangler.json','utf8'));
const account='12daec56fdba43f677f2766ee26a5a39',database='ca70322e-c692-44b2-9052-de5d01a60e61';assert.equal(config.name,'videoq-acceptance-20261125-c33d');assert.equal(config.account_id,account);assert.equal(config.d1_databases[0].database_id,database);
const token=process.env.CLOUDFLARE_API_TOKEN??readFileSync(process.env.HOME+'/Library/Preferences/.wrangler/config/default.toml','utf8').match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];if(!token)throw Error('Authentication unavailable');
const query=`query getD1QueriesOverviewQuery($accountTag: string, $filter: ZoneWorkersRequestsFilter_InputObject) { viewer { accounts(filter: {accountTag: $accountTag}) { d1QueriesAdaptiveGroups(limit: 20, filter: $filter, orderBy: [sum_queryDurationMs_DESC]) { sum { queryDurationMs rowsRead rowsWritten rowsReturned } avg { queryDurationMs rowsRead rowsWritten rowsReturned } count dimensions { query databaseId } } } } }`;
const filter={AND:[{datetimeHour_geq:'2026-11-25T02:00:00Z',datetimeHour_leq:'2026-11-25T03:00:00Z',databaseId:database}]};
const request={query,operationName:'getD1QueriesOverviewQuery',variables:{accountTag:account,filter}};
const response=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(request)});
assert.equal(response.ok,true);const json=await response.json();assert(!json.errors?.length);const groups=json.data.viewer.accounts[0].d1QueriesAdaptiveGroups;assert(Array.isArray(groups)&&groups.length>0);
writeFileSync(directory+'/d1-insights-exact-private.json',JSON.stringify(json),{mode:0o600});
const rows=groups.map(row=>{assert.equal(row.dimensions.databaseId,database);return {sqlSha256:createHash('sha256').update(row.dimensions.query).digest('hex'),count:row.count,sum:row.sum,avg:row.avg};});
const report={observedAt:new Date().toISOString(),account,database,dataset:'d1QueriesAdaptiveGroups',filter,querySha256:createHash('sha256').update(query).digest('hex'),orderBy:'sum_queryDurationMs_DESC',limit:20,rows,coverage:{sqlGroups:rows.length,providerReportedExecutions:rows.reduce((n,row)=>n+row.count,0),providerReportedRowsReadInSelectedGroups:rows.reduce((n,row)=>n+row.sum.rowsRead,0),allDatabaseRowsRead:null,perRagRequestRowsRead:null},limits:['Two requested hourly buckets02/03UTC;03bucket contains only available events as of observedAt','Top20SQL groups include setup, recovery, auth, maintenance and RAG, not exclusively requests','Adaptive analytics/provider-reported aggregates, not an exact unsampled per-request trace','No overall database read total or fraction inferred from selected groups','Raw SQL/bound literals withheld; hashes may differ from application SQL normalization']};
writeFileSync(directory+'/d1-insights-exact.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({groups:rows.length,coverage:report.coverage}));
