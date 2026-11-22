import { consumeBackgroundJobs } from "./integrations/background-jobs/queue";
import { applicationTrafficPaused, migrationPausedResponse } from "./lib/migration-traffic";
import { createApp, type AppType } from "./app";
import { runScheduledMaintenance } from "./lib/scheduled-maintenance";
import type { Bindings } from "./types/bindings";
import { dispatchChatExecution, isChatExecutionRequest } from "./lib/chat-execution";

export type { AppType };

// Cloudflare Workers のエントリ（fetch + scheduled）。
const app = createApp();

export default {
  fetch(request, env, ctx) {
    if (applicationTrafficPaused(env) && isChatExecutionRequest(request)) return migrationPausedResponse();
    if (isChatExecutionRequest(request)) return dispatchChatExecution(request, env);
    return app.fetch(request, env, ctx);
  },
  queue: consumeBackgroundJobs,
  async scheduled(
    controller: ScheduledController,
    env: Bindings,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await runScheduledMaintenance(env, controller.cron);
  },
} satisfies ExportedHandler<Bindings>;

// Durable Objects（wrangler `durable_objects.bindings` の class_name と一致させる）
export { RateLimiter } from "./durable-objects/rate-limiter";
export { TaskScheduler } from "./durable-objects/task-scheduler";
export { ChatExecution } from "./durable-objects/chat-execution";

export { SearchIndexWorkflow } from "./workflows/search-index";
