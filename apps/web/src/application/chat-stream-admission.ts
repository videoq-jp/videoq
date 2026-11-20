import type { ChatStreamEvent } from '@videoq/domain/chat';

/** Per-answer semantic state. The transport validates each event's wire shape. */
export function createChatStreamAdmission(): (event: ChatStreamEvent) => void {
  let lastSegmentIndex = -1;
  const sourceIds = new Set<number>();
  return event => {
    if (event.type === 'source') sourceIds.add(event.source.id);
    if (event.type === 'text_delta') {
      if (event.segmentIndex < lastSegmentIndex || event.segmentIndex > lastSegmentIndex + 1) {
        throw new Error('Non-sequential answer segment');
      }
      lastSegmentIndex = event.segmentIndex;
    }
    if (event.type === 'citation' && (event.segmentIndex !== lastSegmentIndex || !sourceIds.has(event.sourceId))) {
      throw new Error('Unknown citation segment or source');
    }
  };
}
