import type { ChatGenerationProgressEvent, ChatStreamEvent, ChatToolProgressEvent } from '@videoq/domain/chat';

interface ChatToolStep {
  id: number;
  tool: ChatToolProgressEvent['tool'];
  status: ChatToolProgressEvent['status'] | 'interrupted';
}

interface ChatSearchStep {
  id: number;
  query: string;
  status: 'running' | 'complete' | 'interrupted';
}

export interface ChatProgress {
  phase: 'preparing' | 'searching' | 'complete' | 'error' | ChatGenerationProgressEvent['phase'];
  searches: ChatSearchStep[];
  tools?: ChatToolStep[];
}

export const createChatProgress = (): ChatProgress => ({ phase: 'preparing', searches: [] });

export function updateChatProgress(progress: ChatProgress, event: ChatStreamEvent): ChatProgress {
  if (progress.phase === 'error' || progress.phase === 'complete') return progress;

  if (event.type === 'generation_progress') {
    // Once answer text is arriving, late progress must not replace that state.
    if (progress.phase === 'answering' && event.phase !== 'answering') return progress;
    if (progress.phase === event.phase) return progress;
    return { ...progress, phase: event.phase };
  }

  if (event.type === 'tool_progress') {
    const tools = [...(progress.tools ?? [])];
    const index = tools.findIndex(step => step.id === event.call_id);
    const step = { id: event.call_id, tool: event.tool, status: event.status };
    if (index < 0) tools.push(step);
    else {
      // Ignore duplicate starts and late events for finished calls.
      if (tools[index].status !== 'running' || tools[index].status === event.status) return progress;
      tools[index] = step;
    }
    return {
      ...progress, tools,
      phase: tools.some(tool => tool.status === 'running') || progress.searches.some(search => search.status === 'running')
        ? 'searching' : 'reviewing',
    };
  }
  if (event.type === 'searching') {
    const id = event.search_id;
    if (progress.searches.some((search) => search.id === id)) return progress;
    return {
      ...progress,
      phase: 'searching',
      searches: [...progress.searches, { id, query: event.query, status: 'running' }],
    };
  }
  if (event.type === 'search_completed') {
    const searches = progress.searches.map((search): ChatSearchStep => search.id === event.search_id
      ? { ...search, status: 'complete' }
      : search);
    return { ...progress, phase: searches.some((search) => search.status === 'running') || progress.tools?.some(tool => tool.status === 'running') ? 'searching' : 'reviewing', searches };
  }
  if (event.type === 'error') {
    return {
      ...progress,
      phase: 'error',
      tools: progress.tools?.map(tool => tool.status === 'running' ? { ...tool, status: 'interrupted' } : tool),
      searches: progress.searches.map((search) => search.status === 'running'
        ? { ...search, status: 'interrupted' } : search),
    };
  }
  if (event.type === 'done' || event.type === 'citation' ||
      (event.type === 'text_delta' && event.text !== '')) {
    const phase = event.type === 'done' ? 'complete' : 'answering';
    if (phase === progress.phase) return progress;
    return {
      ...progress,
      phase,
      tools: progress.tools?.map(tool => tool.status === 'running' ? { ...tool, status: 'complete' } : tool),
      // Answer content confirms all searches ended.
      searches: progress.searches.map((search) => search.status === 'running'
        ? { ...search, status: 'complete' } : search),
    };
  }
  return progress;
}
