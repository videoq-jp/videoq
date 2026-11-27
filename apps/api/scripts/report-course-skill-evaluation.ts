import { parseArgs } from 'node:util';
import { createAssessmentReport } from './course-skill-evaluation/assessment-report';
import { evaluationCases } from './course-skill-evaluation/cases';

const { values } = parseArgs({ options: { directory: { type: 'string' }, reviewer: { type: 'string' }, assessments: { type: 'string' }, output: { type: 'string' } } });
try {
  if (!values.directory || !values.reviewer || !values.assessments || !values.output) console.info('Use --directory PRIVATE_COHORT --reviewer REVIEWER_DIRECTORY --assessments COMPLETED_PRIVATE_JSON --output NEW_PRIVATE_FILE. The human record must include decision=human-reviewed, reviewer identity, the original packetHash, and completed boolean judgments with notes for every trial. No automatic human scoring or model calls.');
  else console.info(JSON.stringify(await createAssessmentReport({ directory: values.directory, reviewerDirectory: values.reviewer, assessmentFile: values.assessments, output: values.output, cases: evaluationCases })));
} catch { console.error('Assessment report stopped. Check completed human judgments and immutable review artifacts; no private assessment notes are logged.'); process.exitCode = 1; }
