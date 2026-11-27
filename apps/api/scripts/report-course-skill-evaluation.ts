import { parseArgs } from 'node:util';
import { createAssessmentReport } from './course-skill-evaluation/assessment-report';
import { evaluationCases } from './course-skill-evaluation/cases';

const { values } = parseArgs({ options: { directory: { type: 'string' }, reviewer: { type: 'string' }, assessments: { type: 'string' }, verification: { type: 'string' }, output: { type: 'string' } } });
try {
  if (!values.directory || !values.reviewer || !values.assessments || !values.verification || !values.output) console.info('Use --directory PRIVATE_COHORT --reviewer REVIEWER_DIRECTORY --assessments COMPLETED_PRIVATE_JSON --verification INDEPENDENT_VERIFICATION_JSON --output NEW_PRIVATE_FILE. Requires explicit completed human or AI judgments and a matching independent frozen-code check. AI judgments require provenance and are never reported as human review. No model calls.');
  else console.info(JSON.stringify(await createAssessmentReport({ directory: values.directory, reviewerDirectory: values.reviewer, assessmentFile: values.assessments, verificationFile: values.verification, output: values.output, cases: evaluationCases })));
} catch { console.error('Assessment report stopped. Check completed judgments and their declared method and immutable review artifacts; no private assessment notes are logged.'); process.exitCode = 1; }
