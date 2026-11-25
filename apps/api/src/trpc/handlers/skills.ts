import type { Context } from 'hono';
import type { AppEnv } from '../../types/bindings';
import { agentSkillService } from '../../integrations/agent-skills';
import { enforceThrottles } from '../../lib/rate-limit';
import { requireUserId, rpcError, type HandlersFor } from './shared';
export function skillHandlers(c: Context<AppEnv>, userId: string | null): HandlersFor<'skills'> {
  const service = () => agentSkillService(c.env, c.env.FRONTEND_URL || new URL(c.req.url).origin);
  const throttle = async (start: boolean) => {
    const denied = await enforceThrottles(c.env, [{ scope: start ? 'skill_start_user' : 'skill_step_user', ident: requireUserId(userId) }]);
    if (denied) rpcError('TOO_MANY_REQUESTS', `Try again in ${denied.retryAfterSec} seconds.`);
  };
  return {
    'skills.start': async input => { await throttle(true); return (await service()).start(requireUserId(userId), input); },
    'skills.advance': async input => { await throttle(false); return (await service()).advance(requireUserId(userId), input.id, c.req.raw.signal); },
    'skills.get': async input => (await service()).get(requireUserId(userId), input.id),
    'skills.publish': async input => (await service()).publish(requireUserId(userId), input.id),
  };
}
