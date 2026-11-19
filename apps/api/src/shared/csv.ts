import type { ChatHistoryExportRow } from "../persistence/contracts/chat-repository";

const NEEDS_QUOTE = /[",\r\n]/;
const SPREADSHEET_FORMULA_PREFIX = /^(?:[=+\-@\t\r\n]|\s+[=+\-@])/u;

/** Prevent spreadsheet programs from evaluating untrusted cells as formulas. */
function neutralizeSpreadsheetFormula(value: string): string {
  return SPREADSHEET_FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

function csvField(value: string): string {
  const safeValue = neutralizeSpreadsheetFormula(value);
  return NEEDS_QUOTE.test(safeValue)
    ? `"${safeValue.replaceAll('"', '""')}"`
    : safeValue;
}

export function csvRow(fields: readonly string[]): string {
  return `${fields.map(csvField).join(",")}\r\n`;
}

const CHAT_HISTORY_HEADER = csvRow([
  "created_at",
  "asked_by_user_id",
  "asked_by_username",
  "asked_by_email",
  "question",
  "answer",
  "is_shared_origin",
  "citations",
  "feedback",
]);

function chatHistoryCsvRow(row: ChatHistoryExportRow): string {
  return csvRow([
    row.created_at,
    row.asked_by?.user_id ?? "",
    row.asked_by?.username ?? "",
    row.asked_by?.email ?? "",
    row.question,
    row.answer,
    row.is_shared_origin ? "true" : "false",
    JSON.stringify(row.citations),
    row.feedback ?? "",
  ]);
}

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
