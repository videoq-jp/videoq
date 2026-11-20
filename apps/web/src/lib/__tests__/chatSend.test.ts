import { describe, expect, it, vi } from 'vitest';
import type { ChatStreamEvent } from '@videoq/domain/chat';
import { sendChatAnswer, type ChatSendDependencies } from '../../application/chat-send';

function fixture(events: ChatStreamEvent[]) {
  const order: string[] = [];
  const deps: ChatSendDependencies = {
    cancelled: () => false,
    started: () => { order.push('start'); },
    events: async function* () { yield* events; },
    present: event => { order.push(`present:${event.type}`); },
    stream: {
      handleEvent: event => { order.push(`stream:${event.type}`); },
      complete: vi.fn(async () => { order.push('drain'); }),
      abort: vi.fn(() => { order.push('abort'); }),
    },
    persisted: vi.fn(refresh => { order.push(`persisted:${refresh}`); }),
    failed: vi.fn(),
  };
  return { deps, order };
}
const done: ChatStreamEvent = { type: 'done' };

describe('chat send workflow', () => {
  it.each([false, true])('notifies persistence before the paint drain and refreshes only the paying account (shared=%s)', async shared => {
    const { deps, order } = fixture([done, { type: 'error', code: 'late', message: 'ignored' }]);
    await sendChatAnswer(shared, deps);
    expect(order).toEqual(['start', 'present:done', 'stream:done', `persisted:${!shared}`, 'drain']);
    expect(deps.failed).not.toHaveBeenCalled();
  });
  it('ends on a semantic error without persisting or draining', async () => {
    const { deps, order } = fixture([{ type: 'error', code: 'busy', message: 'busy' }, done]);
    await sendChatAnswer(false, deps);
    expect(order).toEqual(['start', 'present:error', 'stream:error']);
    expect(deps.persisted).not.toHaveBeenCalled();
  });
  it('suppresses events and failures after cancellation', async () => {
    const { deps, order } = fixture([done]);
    deps.cancelled = () => true;
    await sendChatAnswer(false, deps);
    expect(order).toEqual(['start']);
    deps.events = async function* () { yield* []; throw new Error('aborted'); };
    await sendChatAnswer(false, deps);
    expect(deps.failed).not.toHaveBeenCalled();
    expect(deps.stream.abort).not.toHaveBeenCalled();
  });
  it('aborts pending presentation before exposing a transport failure', async () => {
    const { deps, order } = fixture([]);
    const error = new Error('transport');
    deps.events = async function* () { yield* []; throw error; };
    deps.failed = vi.fn(() => { order.push('failure'); });
    await sendChatAnswer(false, deps);
    expect(order).toEqual(['start', 'abort', 'failure']);
    expect(deps.failed).toHaveBeenCalledWith(error);
  });
  it('drains an exhausted stream even without a done event', async () => {
    const { deps, order } = fixture([]);
    await sendChatAnswer(false, deps);
    expect(order).toEqual(['start', 'drain']);
    expect(deps.persisted).not.toHaveBeenCalled();
  });
});
