import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {inspectCloudCutoverConfig} from './migrations/d1/cutover-config';
export async function main(args=process.argv.slice(2)){
 if(args.length!==4||args[0]!=='--config'||args[2]!=='--env')throw new Error('Use --config <wrangler.jsonc> --env <environment>.');
 const result=inspectCloudCutoverConfig(await readFile(resolve(args[1]),'utf8'),args[3]);
 // Output only known diagnostic strings, never configuration/secret values.
 console.info(JSON.stringify(result,null,2));if(!result.configuration_valid)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{await main();}catch{console.error('D1 cutover configuration check failed. Verify the arguments and config file.');process.exitCode=1;}}
