import { ChatStreamController as ApplicationController } from '../application/chat-stream';
import type { ChatStreamControllerOptions } from '../application/chat-stream';
export { createInitialChatStreamState, chatStreamReducer } from '../application/chat-stream';
export type { ChatStreamState, ChatStreamAction, ChatStreamDoneEvent, ChatStreamErrorEvent } from '../application/chat-stream';

/** Browser scheduling is composed here; application state has no DOM dependency. */
export class ChatStreamController extends ApplicationController {
  constructor(options: Omit<ChatStreamControllerOptions, 'scheduler'>) {
    super({ ...options, scheduler: {
      request: callback => requestAnimationFrame(callback), cancel: handle => cancelAnimationFrame(handle),
      hidden: () => document.hidden,
      listen: callback => document.addEventListener('visibilitychange', callback),
      unlisten: callback => document.removeEventListener('visibilitychange', callback),
    } });
  }
}
