import type { ChatHistoryExportRow } from "../persistence/contracts/chat-repository";
import { CHAT_HISTORY_HEADER, chatHistoryCsvRow } from "../application/csv";
export { csvRow } from "../application/csv";

/** Encode one CSV row per pull so history size never determines Worker memory use. */
export function streamChatHistoryCsv(
  rows: AsyncIterable<ChatHistoryExportRow>,
): ReadableStream<Uint8Array> {
  const iterator = rows[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let headerPending = true;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (headerPending) {
        headerPending = false;
        controller.enqueue(encoder.encode(CHAT_HISTORY_HEADER));
        return;
      }
      try {
        const result = await iterator.next();
        if (result.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chatHistoryCsvRow(result.value)));
      } catch (error) {
        try {
          await iterator.return?.();
        } catch {
          // Preserve the original stream error.
        }
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
