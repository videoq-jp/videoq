import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildMigrationManifest} from './migrations/d1/manifest';
export async function loadMigrationSnapshot(folder:string){
 const journal=JSON.parse(await readFile(resolve(folder,'meta/_journal.json'),'utf8')) as {entries:{idx:number}[]};
 const last=journal.entries.at(-1);if(!last)throw new Error('Missing migration journal.');
 return JSON.parse(await readFile(resolve(folder,'meta',String(last.idx).padStart(4,'0')+'_snapshot.json'),'utf8')) as unknown;
}
export async function main(args=process.argv.slice(2)){
 if(args.length&&(args.length!==1||args[0]!=='--check'))throw new Error('Use no arguments or --check.');
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 const result=buildMigrationManifest(await loadMigrationSnapshot(resolve(root,'drizzle')),await loadMigrationSnapshot(resolve(root,'drizzle-d1')));
 console.info(JSON.stringify(args[0]==='--check'?{mapping_complete:result.mapping_complete,issues:result.issues,row_tables:result.tables.filter(table=>table.policy==='convert_rows').length,special_source_tables:result.tables.filter(table=>table.target===null).length,special_target_tables:result.target_only.length,execution_complete:result.execution_complete}:result,null,2));if(!result.mapping_complete)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{await main();}catch{console.error('Migration manifest generation failed; inspect snapshot structure and journal coverage.');process.exitCode=1;}}
