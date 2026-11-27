import { parseArgs } from 'node:util';
import { verifyFrozenCohort } from './course-skill-evaluation/strict-verification';
import { evaluationCases } from './course-skill-evaluation/cases';

const { values } = parseArgs({ options: { directory: { type: 'string' }, output: { type: 'string' } } });
try {
  if (!values.directory || !values.output) console.info('Use --directory COMPLETE_PRIVATE_COHORT --output NEW_PRIVATE_FILE. Reconstructs frozen output and rechecks contract tests using process-isolated Node test events. No model reruns or original-record changes.');
  else console.info(JSON.stringify(await verifyFrozenCohort({ directory: values.directory, output: values.output, cases: evaluationCases })));
} catch { console.error('Independent verification stopped. Check completed trials and immutable snapshots; no generated code is logged.'); process.exitCode = 1; }
