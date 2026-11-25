/** Isolated rehearsal only. Production admin authorization remains createApp's
 * session/adminProcedure path; Workflow injection is controlled by fixture D1. */
import { createApp } from '../../src/app';
export { RecoveryWorkflow } from './search-recovery-fixture.worker';
const app=createApp();
export default {fetch:app.fetch};
