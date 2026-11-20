import type { ChatStreamEvent } from '@videoq/domain/chat';
import { appendChatPart, type ChatContentPart } from '@videoq/domain/chat';

export type ChatStreamDoneEvent = Extract<ChatStreamEvent, { type: 'done' }>;
export type ChatStreamErrorEvent = Extract<ChatStreamEvent, { type: 'error' }>;

export interface ChatStreamState {
  queuedParts: ChatContentPart[];
  doneEvent: ChatStreamDoneEvent | null;
  streamFinished: boolean;
}

export type ChatStreamAction =
  | { type: 'stream_started' }
  | { type: 'stream_event'; event: ChatStreamEvent }
  | { type: 'stream_finished' }
  | { type: 'parts_drained'; remaining: ChatContentPart[] }
  | { type: 'done_applied' }
  | { type: 'stream_aborted' };

export interface ChatFrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
  hidden(): boolean;
  listen(callback: () => void): void;
  unlisten(callback: () => void): void;
}

export interface ChatStreamControllerOptions {
  scheduler: ChatFrameScheduler;
  flush?: (callback: () => void) => void;
  onAppendParts: (parts: ChatContentPart[]) => void;
  onDone: (event: ChatStreamDoneEvent) => void;
  onError: (event: ChatStreamErrorEvent) => void;
}

export function createInitialChatStreamState(): ChatStreamState {
  return {
    queuedParts: [],
    doneEvent: null,
    streamFinished: false,
  };
}

export function chatStreamReducer(
  state: ChatStreamState,
  action: ChatStreamAction,
): ChatStreamState {
  switch (action.type) {
    case 'stream_started':
      return createInitialChatStreamState();
    case 'stream_event':
      if (state.streamFinished && action.event.type !== 'error') return state;
      if (action.event.type === 'text_delta' || action.event.type === 'citation') {
        const queuedParts = [...state.queuedParts];
        const last = queuedParts.at(-1);
        if (last) queuedParts[queuedParts.length - 1] = { ...last };
        appendChatPart(queuedParts, action.event.type === 'text_delta'
          ? { type: 'text', text: action.event.text, segmentIndex: action.event.segmentIndex }
          : { type: 'citation', sourceId: action.event.sourceId, segmentIndex: action.event.segmentIndex });
        return { ...state, queuedParts };
      }
      if (action.event.type === 'done') {
        return {
          ...state,
          doneEvent: action.event,
          streamFinished: true,
        };
      }
      if (action.event.type === 'error') {
        return {
          ...state,
          queuedParts: [],
          doneEvent: null,
          streamFinished: true,
        };
      }
      // 検索の進行状況は useChatMessages 側で扱う。本文の描画キューは変更しない。
      return state;
    case 'stream_finished':
      return {
        ...state,
        streamFinished: true,
      };
    case 'parts_drained':
      return { ...state, queuedParts: action.remaining };
    case 'done_applied':
      return {
        ...state,
        doneEvent: null,
      };
    case 'stream_aborted':
      return {
        ...createInitialChatStreamState(),
        streamFinished: true,
      };
    default:
      return state;
  }
}

export class ChatStreamController {
  private readonly scheduler: ChatFrameScheduler;
  private state = createInitialChatStreamState();
  private drainFrame: number | null = null;
  private readonly flush: (callback: () => void) => void;
  private readonly onAppendParts: (parts: ChatContentPart[]) => void;
  private readonly onDone: (event: ChatStreamDoneEvent) => void;
  private readonly onError: (event: ChatStreamErrorEvent) => void;
  private waiters: Array<() => void> = [];
  private readonly handleVisibilityChange = () => {
    if (this.scheduler.hidden()) this.tryFinalizeDrain();
  };

  constructor({
    scheduler,
    flush = (callback) => callback(),
    onAppendParts,
    onDone,
    onError,
  }: ChatStreamControllerOptions) {
    this.scheduler = scheduler;
    this.flush = flush;
    this.onAppendParts = onAppendParts;
    this.onDone = onDone;
    this.onError = onError;
  }

  start() {
    this.cancelDrainFrame();
    this.flushDrainWaiters();
    this.state = chatStreamReducer(this.state, { type: 'stream_started' });
  }

  handleEvent(event: ChatStreamEvent) {
    if (this.state.streamFinished) return;
    this.state = chatStreamReducer(this.state, { type: 'stream_event', event });

    if (event.type === 'text_delta' || event.type === 'citation') {
      this.ensureDrainFrame();
      return;
    }

    if (event.type === 'done') {
      this.tryFinalizeDrain();
      return;
    }

    if (event.type !== 'error') return; // searching など進行状況のみのイベント

    this.cancelDrainFrame();
    this.flushDrainWaiters();
    this.onError(event);
  }

  async complete() {
    this.state = chatStreamReducer(this.state, { type: 'stream_finished' });
    this.tryFinalizeDrain();
    await this.waitForDrainCompletion();
  }

  async waitForDrainCompletion() {
    if (this.canFinalize()) {
      this.tryFinalizeDrain();
      return;
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  abort() {
    this.cancelDrainFrame();
    this.state = chatStreamReducer(this.state, { type: 'stream_aborted' });
    this.flushDrainWaiters();
  }

  dispose() {
    this.abort();
    this.state = createInitialChatStreamState();
  }

  getSnapshot() {
    return {
      ...this.state,
      framePending: this.drainFrame !== null,
    };
  }

  private drainQueuedParts() {
    this.cancelDrainFrame();
    const ready = this.state.queuedParts;
    if (ready.length > 0) {
      this.state = chatStreamReducer(this.state, { type: 'parts_drained', remaining: [] });
      this.flush(() => this.onAppendParts(ready));
    }
    this.tryFinalizeDrain();
  }

  private ensureDrainFrame() {
    if (this.drainFrame !== null) {
      return;
    }

    // Coalesce all received parts into the browser's next paint, without a
    // fixed delay or a recurring callback when there is nothing to render.
    this.drainFrame = this.scheduler.request(() => this.drainQueuedParts());
    this.scheduler.listen(this.handleVisibilityChange);
  }

  private tryFinalizeDrain() {
    if (this.state.queuedParts.length > 0) {
      // Hidden tabs can pause animation frames. Finish without waiting for a
      // paint, including when the tab is hidden after the terminal event.
      if (this.state.streamFinished && this.scheduler.hidden()) this.drainQueuedParts();
      return;
    }

    this.cancelDrainFrame();

    if (!this.state.streamFinished) {
      return;
    }

    const doneEvent = this.state.doneEvent;
    if (doneEvent) {
      this.state = chatStreamReducer(this.state, { type: 'done_applied' });
      this.onDone(doneEvent);
    }

    this.flushDrainWaiters();
  }

  private canFinalize() {
    return this.state.queuedParts.length === 0 && this.state.streamFinished;
  }

  private cancelDrainFrame() {
    if (this.drainFrame === null) {
      return;
    }

    this.scheduler.cancel(this.drainFrame);
    this.drainFrame = null;
    this.scheduler.unlisten(this.handleVisibilityChange);
  }

  private flushDrainWaiters() {
    const waiters = this.waiters.splice(0);
    waiters.forEach((resolve) => resolve());
  }
}
