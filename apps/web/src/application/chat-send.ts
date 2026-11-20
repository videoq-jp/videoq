import type { ChatStreamEvent } from '@videoq/domain/chat';

export interface ChatSendDependencies {
  cancelled(): boolean;
  started(): void;
  events(): AsyncIterable<ChatStreamEvent>;
  present(event: ChatStreamEvent): void;
  stream: {
    handleEvent(event: ChatStreamEvent): void;
    complete(): Promise<void>;
    abort(): void;
  };
  persisted(refreshAccount: boolean): void;
  failed(error: unknown): void;
}

/** Transport and UI adapters supply events and effects; this owns send ordering. */
export async function sendChatAnswer(shared: boolean, deps: ChatSendDependencies): Promise<void> {
  try {
    deps.started();
    for await (const event of deps.events()) {
      if (deps.cancelled()) return;
      deps.present(event);
      deps.stream.handleEvent(event);
      if (event.type === 'error') return;
      if (event.type === 'done') {
        // Shared answers spend the owner's quota, not the visitor's account.
        deps.persisted(!shared);
        break;
      }
    }
    await deps.stream.complete();
  } catch (error) {
    if (deps.cancelled()) return;
    deps.stream.abort();
    deps.failed(error);
  }
}
