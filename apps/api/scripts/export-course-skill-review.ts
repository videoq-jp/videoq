import { parseArgs } from 'node:util';
import { exportReviewPackets } from './course-skill-evaluation/review-packets';
import { evaluationCases } from './course-skill-evaluation/cases';

const { values } = parseArgs({ options: { directory: { type: 'string' }, output: { type: 'string' } } });
try {
  if (!values.directory || !values.output) console.info('Use --directory PRIVATE_COHORT --output NEW_PRIVATE_DIRECTORY. Requires all planned trials and immutable output snapshots. Give only the reviewer subdirectory to the assessor; operator-key.json reveals conditions and machine scores. No model calls or automatic human scoring.');
  else console.info(JSON.stringify(await exportReviewPackets({ directory: values.directory, output: values.output, cases: evaluationCases })));
} catch { console.error('Review export stopped. Check completion and artifact integrity; no course content is logged.'); process.exitCode = 1; }
