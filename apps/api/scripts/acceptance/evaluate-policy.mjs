/** Pure snapshot evaluator: no network, credentials, SQL or notification delivery. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { evaluateOperationalPolicy, OPERATIONAL_POLICY } from '../../src/domain/operations/operational-policy.ts';
export const POLICY = OPERATIONAL_POLICY;
export const evaluatePolicy = evaluateOperationalPolicy;
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.argv.length!==3) throw Error('Usage: node evaluate-policy.mjs snapshot.json');
  process.stdout.write(JSON.stringify(evaluatePolicy(JSON.parse(readFileSync(process.argv[2],'utf8'))),null,2)+'\n');
}
