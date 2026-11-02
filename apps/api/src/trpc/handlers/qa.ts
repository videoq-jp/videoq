import type { Context } from 'hono';
import type { AppEnv } from '../../types/bindings';
import { clientIp, enforceThrottles } from '../../lib/rate-limit';
import * as qa from '../../features/qa/service';
import { requireUserId, rpcError, type HandlersFor } from './shared';

export function qaHandlers(c: Context<AppEnv>, userId: string | null): HandlersFor<'qa'> {
  const throttle = async (write: boolean) => {
    const denied = await enforceThrottles(c.env, [{ scope: write ? 'course_qa_write' : 'course_qa_read', ident: write ? requireUserId(userId) : clientIp(c) }]);
    if (denied) rpcError('TOO_MANY_REQUESTS', `Try again in ${denied.retryAfterSec} seconds.`);
  };
  const mutate = async (command: qa.QaCommand) => { await throttle(true); return qa.mutate(c.env, requireUserId(userId), command); };
  const change = async (command: qa.QaCommand) => {
    const result = await mutate(command);
    if (!('success' in result)) return rpcError('INTERNAL_SERVER_ERROR','Unexpected Q&A response');
    return result;
  };
  const create = async (command: qa.QaCommand) => {
    const result = await mutate(command);
    if (!('id' in result)) return rpcError('INTERNAL_SERVER_ERROR','Unexpected Q&A response');
    return result;
  };
  return {
    'qa.list': async input => { await throttle(false); return qa.listQuestions(c.env,userId,input); },
    'qa.get': async input => { await throttle(false); return qa.getQuestion(c.env,userId,input); },
    'qa.ask': input => create({ name:'qa.ask',input }),
    'qa.reply': input => create({ name:'qa.reply',input }),
    'qa.updateQuestion': input => change({ name:'qa.updateQuestion',input }),
    'qa.deleteQuestion': input => change({ name:'qa.deleteQuestion',input }),
    'qa.updateReply': input => change({ name:'qa.updateReply',input }),
    'qa.deleteReply': input => change({ name:'qa.deleteReply',input }),
    'qa.vote': input => change({ name:'qa.vote',input }),
    'qa.feature': input => change({ name:'qa.feature',input }),
  };
}
