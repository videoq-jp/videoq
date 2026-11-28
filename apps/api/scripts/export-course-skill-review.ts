import { parseArgs } from 'node:util';
import { exportReviewPackets } from './course-skill-evaluation/review-packets';
import { evaluationCases } from './course-skill-evaluation/cases';

const { values } = parseArgs({ options: { directory: { type: 'string' }, output: { type: 'string' }, 'include-execution-evidence': { type: 'boolean', default: false } } });
try {
  if (!values.directory || !values.output) console.info('Use --directory PRIVATE_COHORT --output NEW_PRIVATE_DIRECTORY. Requires all planned trials and immutable output snapshots. Add --include-execution-evidence to include observed operations and the configured tool catalog; independent functional grades stay hidden, but tool use can reveal treatment. Give only the reviewer subdirectory to the assessor; operator-key.json reveals conditions and machine scores. No model calls or automatic human scoring.');
  else console.info(JSON.stringify(await exportReviewPackets({ directory: values.directory, output: values.output, cases: evaluationCases, includeExecutionEvidence: values['include-execution-evidence'] })));
} catch { console.error('Review export stopped. Check completion and artifact integrity; no course content is logged.'); process.exitCode = 1; }
