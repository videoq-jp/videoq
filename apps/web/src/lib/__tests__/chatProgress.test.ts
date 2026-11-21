import { createChatProgress, updateChatProgress } from '../chatProgress';

describe('chat progress', () => {
  it('tracks actual model stages around repeated searches and ignores late progress after answer text', () => {
    let progress = createChatProgress();
    for (const phase of ['thinking', 'summarizing', 'thinking'] as const) {
      progress = updateChatProgress(progress, { type: 'generation_progress', phase });
      expect(progress.phase).toBe(phase);
    }
    progress = updateChatProgress(progress, { type: 'tool_progress', call_id: 1, tool: 'search_scenes', status: 'running' });
    expect(progress.phase).toBe('searching');
    progress = updateChatProgress(progress, { type: 'tool_progress', call_id: 1, tool: 'search_scenes', status: 'complete' });
    progress = updateChatProgress(progress, { type: 'generation_progress', phase: 'reviewing' });
    expect(progress.phase).toBe('reviewing');
    progress = updateChatProgress(progress, { type: 'tool_progress', call_id: 2, tool: 'search_scenes', status: 'running' });
    expect(progress.phase).toBe('searching');
    progress = updateChatProgress(progress, { type: 'tool_progress', call_id: 2, tool: 'search_scenes', status: 'complete' });
    progress = updateChatProgress(progress, { type: 'generation_progress', phase: 'summarizing' });
    expect(progress.phase).toBe('summarizing');
    progress = updateChatProgress(progress, { type: 'generation_progress', phase: 'reviewing' });
    progress = updateChatProgress(progress, { type: 'text_delta', segmentIndex: 0, text: '回答' });
    expect(progress.phase).toBe('answering');
    expect(updateChatProgress(progress, { type: 'generation_progress', phase: 'reviewing' })).toBe(progress);
    progress = updateChatProgress(progress, { type: 'done', chat_log_id: null, feedback: null });
    expect(updateChatProgress(progress, { type: 'generation_progress', phase: 'thinking' })).toBe(progress);
  });

  it('tracks concurrent and repeated tools through legacy search events and ignores duplicate starts', () => {
    let progress = createChatProgress();
    const start = { type: 'tool_progress', call_id: 1, tool: 'focus_clip', status: 'running' } as const;
    progress = updateChatProgress(progress, start);
    expect(updateChatProgress(progress, start)).toBe(progress);
    progress = updateChatProgress(progress, { ...start, call_id: 2 });
    progress = updateChatProgress(progress, { type: 'searching', search_id: 1, query: '回路' });
    progress = updateChatProgress(progress, { type: 'search_completed', search_id: 1, query: '回路', result_count: 1 });
    expect(progress.phase).toBe('searching');
    progress = updateChatProgress(progress, { ...start, call_id: 2, status: 'complete' });
    expect(progress.phase).toBe('searching');
    progress = updateChatProgress(progress, { ...start, status: 'error' });
    expect(progress.phase).toBe('reviewing');
    expect(progress.tools?.map(tool => tool.status)).toEqual(['error', 'complete']);
    expect(updateChatProgress(progress, start)).toBe(progress);
    progress = updateChatProgress(progress, { ...start, call_id: 3 });
    progress = updateChatProgress(progress, { type: 'error', code: 'STREAM_ERROR', message: 'Disconnected' });
    expect(progress.tools?.map(tool => tool.status)).toEqual(['error', 'complete', 'interrupted']);
    expect(updateChatProgress(progress, { ...start, call_id: 3, status: 'complete' })).toBe(progress);
  });

  it('keeps searching while another parallel search is still running', () => {
    let progress = createChatProgress();
    progress = updateChatProgress(progress, { type: 'searching', search_id: 1, query: '回路' });
    progress = updateChatProgress(progress, { type: 'searching', search_id: 2, query: '定理' });
    progress = updateChatProgress(progress, { type: 'search_completed', search_id: 2, query: '定理', result_count: 0 });
    expect(progress.phase).toBe('searching');
    expect(progress.searches[1]).toMatchObject({ status: 'complete' });
    progress = updateChatProgress(progress, { type: 'search_completed', search_id: 1, query: '回路', result_count: 20 });
    expect(progress.phase).toBe('reviewing');
    progress = updateChatProgress(progress, { type: 'searching', search_id: 3, query: 'ドモルガン' });
    expect(progress.phase).toBe('searching');
    expect(progress.searches[0].status).toBe('complete');
  });

  it('preserves completed searches and stops unfinished ones on failure', () => {
    let progress = updateChatProgress(createChatProgress(), { type: 'searching', search_id: 1, query: '回路' });
    progress = updateChatProgress(progress, { type: 'search_completed', search_id: 1, query: '回路', result_count: 20 });
    progress = updateChatProgress(progress, { type: 'searching', search_id: 2, query: '追加検索' });
    progress = updateChatProgress(progress, { type: 'error', code: 'LLM_PROVIDER_ERROR', message: 'failed' });
    expect(progress.phase).toBe('error');
    expect(progress.searches.map((search) => search.status)).toEqual(['complete', 'interrupted']);
    expect(updateChatProgress(progress, { type: 'text_delta', segmentIndex: 0, text: 'late' })).toBe(progress);
  });

  it('transitions from search to nonempty answer content and completion', () => {
    let progress = updateChatProgress(createChatProgress(), { type: 'searching', search_id: 1, query: '回路' });
    expect(updateChatProgress(progress, { type: 'text_delta', segmentIndex: 0, text: '' })).toBe(progress);
    progress = updateChatProgress(progress, { type: 'text_delta', segmentIndex: 0, text: '回答' });
    expect(progress.phase).toBe('answering');
    expect(progress.searches[0]).toEqual({ id: 1, query: '回路', status: 'complete' });
    progress = updateChatProgress(progress, { type: 'done', chat_log_id: 1, feedback: null });
    expect(progress.phase).toBe('complete');
  });
});
