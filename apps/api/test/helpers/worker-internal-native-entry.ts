import {Hono} from 'hono';
import {workerInternalRoutes} from '../../src/features/worker-internal/routes';
import type {AppEnv} from '../../src/types/bindings';
// Test-only entrypoint. No production binding, scheduler, external queue or model.
export default new Hono<AppEnv>().route('/internal/worker',workerInternalRoutes);
