import { advanceChatTextContext, parseChatText, type ChatAnswer, type ChatTextNode } from '@videoq/domain/chat';

export type MessageContentNode = ChatTextNode | { type: 'refs'; ids: number[] };

export function parseMessageContent(segments: ChatAnswer['segments']): MessageContentNode[] {
  const nodes: MessageContentNode[] = [];
  let context = { previous: '', linePrefix: '' };
  let text = '';
  const flushText = () => {
    for (const node of parseChatText(text, context)) {
      const last = nodes.at(-1);
      if (last?.type === 'text' && node.type === 'text') last.value += node.value;
      else nodes.push(node);
    }
    context = advanceChatTextContext(context, text);
    text = '';
  };
  for (const segment of segments) {
    text += segment.text;
    // Adjacent segments without citations can split a TeX/code delimiter.
    if (!segment.sourceIds.length) continue;
    flushText();
    nodes.push({ type: 'refs', ids: [...new Set(segment.sourceIds)] });
  }
  flushText();
  return nodes;
}
