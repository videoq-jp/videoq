// Generate the operator-managed tool key ring without printing private material.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const target = process.argv[2];
if (!target || process.argv.length !== 3) throw new Error('Usage: node scripts/generate-lti-tool-keys.mjs /secure/path/lti-tool-keys.json');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
writeFileSync(resolve(target), JSON.stringify({ current: privateKey.export({ format: 'jwk' }), previous: [] }), { flag: 'wx', mode: 0o600 });
console.log('Created LTI tool key ring. Load this file as the LTI_TOOL_KEYS secret; never commit it.');
