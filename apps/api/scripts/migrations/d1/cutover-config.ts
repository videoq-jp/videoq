import ts from 'typescript';
type RecordValue=Record<string,unknown>;
const record=(value:unknown):RecordValue=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as RecordValue:{};
const list=(value:unknown):RecordValue[]=>Array.isArray(value)?value.map(record):[];
const present=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0;
export function inspectCloudCutoverConfig(text:string,environment:string){
 const parsed=ts.parseConfigFileTextToJson('wrangler.jsonc',text);
 if(parsed.error)return {configuration_valid:false,errors:['Invalid Wrangler JSONC.'],warnings:[] as string[]};
 const root=record(parsed.config as unknown),environments=record(root.env),scope=record(environments[environment]);
 const errors:string[]=[],warnings:string[]=[];
 if(!Object.hasOwn(environments,environment))errors.push('Requested Wrangler environment is missing.');
 // vars, D1, Vectorize and Hyperdrive are non-inheritable Wrangler settings.
 const vars=record(scope.vars);
 if(vars.ENVIRONMENT!=='production')errors.push('ENVIRONMENT must be production for a public cutover target.');
 if(vars.DEPLOYMENT_EDITION!=='cloud')errors.push('DEPLOYMENT_EDITION must explicitly be cloud.');
 if(vars.PERSISTENCE_BACKEND!==undefined&&vars.PERSISTENCE_BACKEND!=='d1')errors.push('PERSISTENCE_BACKEND must select D1.');
 if(vars.MIGRATION_ALLOW_CLOUD_POSTGRES==='true')errors.push('Cloud PostgreSQL rollback override must be disabled for D1 cutover.');
 const databases=list(scope.d1_databases).filter(binding=>binding.binding==='DB');
 if(databases.length!==1)errors.push('Exactly one D1 binding named DB is required.');
 else{
  const db=databases[0];
  if(typeof db.database_id!=='string'||!(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(db.database_id))||/^0+-0+-0+-0+-0+$/.test(db.database_id))errors.push('DB requires a real D1 database_id.');
  if(!present(db.database_name))errors.push('DB database_name is required.');
  if(db.migrations_dir!=='drizzle-d1')errors.push('DB migrations_dir must be drizzle-d1, separate from PostgreSQL history.');
  if(db.migrations_pattern!==undefined&&db.migrations_pattern!=='drizzle-d1/*.sql')errors.push('DB migrations_pattern must include the complete D1 SQL history.');
  if(db.remote===false)warnings.push('DB remote=false is configured; verify remote migration commands explicitly.');
 }
 const vectors=list(scope.vectorize),indexes=[];
 for(const binding of ['SCENE_VECTORIZE_1536','SCENE_VECTORIZE_768']){
  const matches=vectors.filter(value=>value.binding===binding);
  if(matches.length!==1||!present(matches[0].index_name))errors.push(`${binding} requires exactly one named Vectorize index.`);
  else indexes.push(matches[0].index_name);
 }
 if(indexes.length===2&&indexes[0]===indexes[1])errors.push('768- and 1536-dimensional vectors require separate indexes.');
 if(list(scope.hyperdrive).length)warnings.push('Hyperdrive remains configured; remove it after the rollback retention period.');
 if(scope.workers_dev!==false)errors.push('workers_dev must remain false for the cutover target.');
 if(!present(scope.name))errors.push('Target Worker name is required.');
 for(const key of ['WORKER_INTERNAL_API_SECRET','BETTER_AUTH_SECRET','DATABASE_URL','OPENAI_API_KEY'])if(Object.hasOwn(vars,key))errors.push(`${key} must be provisioned as a secret, not plaintext Wrangler vars.`);
 warnings.push('This local check does not verify remote database migrations, Vectorize dimensions/metric/filter indexes, secret presence, AWS Worker configuration, data integrity, search quality, performance or budget.');
 return {configuration_valid:errors.length===0,errors,warnings};
}
