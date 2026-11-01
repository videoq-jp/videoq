import { chatAnswerText } from "@videoq/trpc/chat";
import type { Message } from "../useChatMessages";
const messageText = (message: Message | undefined) => message?.role === "assistant" ? chatAnswerText(message.answer) : message?.content;
import { renderHook, act, waitFor } from '@testing-library/react'
import { useChatMessages } from '../useChatMessages'
import { apiClient } from '@/lib/api'

const setFeedback = vi.fn()

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    apiClient: {
      chatStream: vi.fn(),
    },
  }
})

// Helper: create an async generator mock for chatStream
function makeStreamMock(
  chunks: string[],
  done?: { chat_log_id?: number | null; feedback?: 'good' | 'bad' | null; feedback_token?: string; citations?: unknown[] },
) {
  return async function* () {
    for (const source of done?.citations ?? []) yield { type: 'source' as const, source };
    for (const text of chunks) {
      yield { type: 'text_delta' as const, segmentIndex: 0, text }
    }
    yield {
      type: 'done' as const,
      chat_log_id: done?.chat_log_id ?? null,
      feedback: done?.feedback ?? null,
      feedback_token: done?.feedback_token,
    }
  }
}

describe('useChatMessages streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setFeedback.mockReset()
    globalThis.__setTrpcHandler('chat.feedback', setFeedback)
  })

  afterEach(() => vi.unstubAllEnvs())

  it('follows text and arriving timestamps only at the bottom, without scrolling for tool-only updates', () => {
    const { result } = renderHook(() => useChatMessages({ courseId: 18 }))
    const container = document.createElement('div')
    let height = 800
    let top = 400
    const scrollTo = vi.fn((value: number) => { top = Math.min(value, height - 400) })
    Object.defineProperties(container, {
      clientHeight: { get: () => 400 },
      scrollHeight: { get: () => height },
      scrollTop: { get: () => top, set: scrollTo },
    })
    result.current.messagesContainerRef.current = container

    height = 900
    act(() => result.current.setMessages([{ role: 'assistant', answer: { segments: [{ text: '回答の始まり', sourceIds: [] }], sources: [] } }]))
    expect(top).toBe(500)

    scrollTo.mockClear()
    act(() => result.current.setMessages([{ role: 'assistant', answer: { segments: [{ text: '回答の始まり', sourceIds: [] }], sources: [] }, progress: {
      phase: 'searching', searches: [{ id: 1, query: '追加の検索', status: 'running' }],
    } }]))
    expect(scrollTo).not.toHaveBeenCalled()

    // The timestamp can arrive later than its text and wrap onto a new line.
    height = 950
    act(() => result.current.setMessages([{ role: 'assistant', answer: {
      segments: [{ text: '回答の始まり', sourceIds: [1] }],
      sources: [{ id: 1, video_id: 7, title: 'Source', start_time: '00:01:00', end_time: null }],
    } }]))
    expect(top).toBe(550)
    scrollTo.mockClear()

    // A reader scrolls away from the bottom while more answer text arrives.
    top = 100
    act(() => result.current.handleMessagesScroll())
    height = 1000
    act(() => result.current.setMessages([{ role: 'assistant', answer: { segments: [{ text: '回答の続き', sourceIds: [] }], sources: [] } }]))
    expect(top).toBe(100)
    expect(scrollTo).not.toHaveBeenCalled()

    // Returning to the bottom resumes following subsequent content.
    top = 600
    act(() => result.current.handleMessagesScroll())
    height = 1100
    act(() => result.current.setMessages([{ role: 'assistant', answer: { segments: [{ text: '回答の終わり', sourceIds: [] }], sources: [] } }]))
    expect(top).toBe(700)
  })

  it('updates progress before answer content and retains it with the finished message', async () => {
    let resume!: () => void
    const waiting = new Promise<void>((resolve) => { resume = resolve })
    vi.mocked(apiClient.chatStream).mockImplementation(async function* () {
      yield { type: 'searching', search_id: 1, query: 'ドモルガンの定理' }
      await waiting
      yield { type: 'search_completed', search_id: 1, query: 'ドモルガンの定理', result_count: 20 }
      yield { type: 'text_delta', segmentIndex: 0, text: '回答' }
      yield { type: 'done', chat_log_id: 12, feedback: null }
    })
    const { result } = renderHook(() => useChatMessages({ courseId: 18 }))
    act(() => { result.current.setInput('回路について') })
    let sending: Promise<void>
    act(() => { sending = result.current.handleSend() })
    await waitFor(() => expect(result.current.messages.at(-1)?.progress?.phase).toBe('searching'))
    expect(messageText(result.current.messages.at(-1))).toBe('')
    expect(result.current.messages.at(-1)?.progress?.searches[0].query).toBe('ドモルガンの定理')
    await act(async () => { resume(); await sending! })
    expect(result.current.messages.at(-1)).toMatchObject({
      answer: { segments: [{ text: '回答', sourceIds: [] }] }, chatLogId: 12,
      progress: { phase: 'complete', searches: [{ query: 'ドモルガンの定理', status: 'complete' }] },
    })
  })

  it('adds an empty assistant message immediately when sending', async () => {
    ;(apiClient.chatStream as any).mockImplementation(makeStreamMock([]))

    const { result } = renderHook(() => useChatMessages({}))

    act(() => {
      result.current.setInput('Hello')
    })

    act(() => {
      void result.current.handleSend()
    })

    // After send is triggered, an empty assistant message should appear
    await waitFor(() => {
      const messages = result.current.messages
      const assistantMsgs = messages.filter((m) => m.role === 'assistant')
      // greeting + new empty one
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('accumulates structured text deltas', async () => {
    ;(apiClient.chatStream as any).mockImplementation(
      makeStreamMock(['Hello ', 'World']),
    )

    const { result } = renderHook(() => useChatMessages({}))

    act(() => {
      result.current.setInput('Hi')
    })

    await act(async () => {
      await result.current.handleSend()
    })

    await waitFor(() => {
      const last = result.current.messages.at(-1)
      expect(messageText(last)).toBe('Hello World')
    })
  })

  it('sets chatLogId and feedback from done event', async () => {
    ;(apiClient.chatStream as any).mockImplementation(
      makeStreamMock(['Response'], { chat_log_id: 99, feedback: null }),
    )

    const { result } = renderHook(() => useChatMessages({}))

    act(() => { result.current.setInput('Hi') })

    await act(async () => { await result.current.handleSend() })

    await waitFor(() => {
      const last = result.current.messages.at(-1)
      expect(last?.chatLogId).toBe(99)
      expect(last?.feedback).toBeNull()
    })
  })

  it('uses the issued shared-answer token for feedback', async () => {
    vi.mocked(apiClient.chatStream).mockImplementation(
      makeStreamMock(['Shared answer'], { chat_log_id: 42, feedback_token: 'issued-answer-token' }),
    )
    setFeedback.mockResolvedValue({ chat_log_id: 42, feedback: 'good' })
    const { result } = renderHook(() => useChatMessages({ courseId: 3, shareToken: 'shared' }))
    act(() => result.current.setInput('Hi'))
    await act(async () => { await result.current.handleSend() })
    expect(result.current.messages.at(-1)?.feedbackToken).toBe('issued-answer-token')
    await act(async () => { await result.current.handleFeedback(42, 'good') })
    expect(setFeedback).toHaveBeenCalledWith({
      chatLogId: 42, feedback: 'good', shareSlug: 'shared', feedbackToken: 'issued-answer-token',
    })
  })

  it('preserves earlier snapshots and completed segments while extending an answer', async () => {
    let resume!: () => void
    const waiting = new Promise<void>(resolve => { resume = resolve })
    const source = { id: 1, video_id: 7, title: 'Source', start_time: '00:00:10', end_time: null }
    vi.mocked(apiClient.chatStream).mockImplementation(async function* () {
      yield { type: 'source', source }
      yield { type: 'text_delta', segmentIndex: 0, text: 'A' }
      yield { type: 'citation', segmentIndex: 0, sourceId: 1 }
      yield { type: 'text_delta', segmentIndex: 1, text: 'B' }
      await waiting
      yield { type: 'text_delta', segmentIndex: 1, text: 'C' }
      yield { type: 'citation', segmentIndex: 1, sourceId: 1 }
      yield { type: 'done', chat_log_id: 42, feedback: null }
    })
    const { result } = renderHook(() => useChatMessages({}))
    act(() => result.current.setInput('Hi'))
    let sending!: Promise<void>
    act(() => { sending = result.current.handleSend() })
    await waitFor(() => expect(messageText(result.current.messages.at(-1))).toBe('AB'))
    const previous = result.current.messages.at(-1)!
    if (previous.role !== 'assistant') throw new Error('Expected assistant answer')
    for (const segment of previous.answer.segments) {
      Object.freeze(segment.sourceIds)
      Object.freeze(segment)
    }
    Object.freeze(previous.answer.segments)
    Object.freeze(previous.answer.sources)
    Object.freeze(previous.answer)
    await act(async () => { resume(); await sending })
    const current = result.current.messages.at(-1)!
    if (current.role !== 'assistant') throw new Error('Expected assistant answer')
    expect(current.answer.segments).toEqual([
      { text: 'A', sourceIds: [1] }, { text: 'BC', sourceIds: [1] },
    ])
    expect(previous.answer.segments).toEqual([
      { text: 'A', sourceIds: [1] }, { text: 'B', sourceIds: [] },
    ])
    expect(current.answer.segments[0]).toBe(previous.answer.segments[0])
    expect(current.answer.sources).toBe(previous.answer.sources)
  })

  it.each([
    { scenario: 'development diagnostics', dev: true, code: 'LLM_PROVIDER_ERROR', message: 'Internal error', expected: 'chat.error (LLM_PROVIDER_ERROR: Internal error)' },
    { scenario: 'empty diagnostics', dev: true, code: 'LLM_PROVIDER_ERROR', message: '', expected: 'chat.error' },
    { scenario: 'whitespace diagnostics', dev: true, code: 'LLM_PROVIDER_ERROR', message: ' \n ', expected: 'chat.error' },
    { scenario: 'production diagnostics', dev: false, code: 'LLM_PROVIDER_ERROR', message: 'Private provider details', expected: 'chat.error' },
    { scenario: 'development quota error', dev: true, code: 'OVER_QUOTA', message: 'Private quota details', expected: 'chat.errorOverQuota' },
    { scenario: 'production quota error', dev: false, code: 'OVER_QUOTA', message: 'Private quota details', expected: 'chat.errorOverQuota' },
    { scenario: 'answer limit error', dev: false, code: 'AI_ANSWERS_LIMIT_EXCEEDED', message: 'Limit: 30', expected: 'chat.errorAnswersLimit' },
  ])('shows the appropriate error and allows retry for $scenario', async ({ dev, code, message, expected }) => {
    vi.stubEnv('DEV', dev)
    vi.mocked(apiClient.chatStream).mockImplementation(async function* () {
      yield { type: 'text_delta', segmentIndex: 0, text: 'Partial answer' }
      yield { type: 'error', code, message }
    })

    const { result } = renderHook(() => useChatMessages({}))

    act(() => { result.current.setInput('Hi') })

    await act(async () => { await result.current.handleSend() })

    expect(result.current.messages.at(-1)).toMatchObject({
      role: 'assistant', answer: { segments: [{ text: expected, sourceIds: [] }], sources: [] }, progress: { phase: 'error' },
    })
    expect(result.current.isLoading).toBe(false)

    // The failed turn must release the send lock and discard queued partial text.
    vi.mocked(apiClient.chatStream).mockImplementation(makeStreamMock(['Recovered']))
    act(() => { result.current.setInput('Try again') })
    await act(async () => { await result.current.handleSend() })
    expect(apiClient.chatStream).toHaveBeenCalledTimes(2)
    expect(messageText(result.current.messages.at(-1))).toBe('Recovered')
    expect(messageText(result.current.messages.at(-3))).toBe(expected)
    expect(result.current.isLoading).toBe(false)
  })

  it('shows error message when chatStream throws', async () => {
    ;(apiClient.chatStream as any).mockImplementation(async function* () {
      throw new Error('Network error')
      yield // make it a generator
    })

    const { result } = renderHook(() => useChatMessages({}))

    act(() => { result.current.setInput('Hi') })

    await act(async () => { await result.current.handleSend() })

    await waitFor(() => {
      const last = result.current.messages.at(-1)
      expect(last?.role).toBe('assistant')
      expect(messageText(last)).toMatch(/chat\.error/)
    })
  })

  it('discards rendered citation state after an error and starts a fresh registry on retry', async () => {
    const source = { id: 1, video_id: 7, title: 'First source', start_time: '00:01:00', end_time: '00:02:00' }
    let fail!: () => void
    const waiting = new Promise<void>(resolve => { fail = resolve })
    vi.mocked(apiClient.chatStream).mockImplementationOnce(async function* () {
      yield { type: 'source', source }
      yield { type: 'text_delta', segmentIndex: 0, text: 'First' }
      yield { type: 'citation', segmentIndex: 0, sourceId: 1 }
      await waiting
      yield { type: 'error', code: 'LLM_PROVIDER_ERROR', message: '' }
    })
    const { result } = renderHook(() => useChatMessages({ courseId: 3 }))
    act(() => result.current.setInput('hello'))
    let sending!: Promise<void>
    act(() => { sending = result.current.handleSend() })
    await waitFor(() => expect(messageText(result.current.messages.at(-1))).toBe('First'))
    expect(result.current.messages.at(-1)?.answer.sources).toEqual([source])
    await act(async () => { fail(); await sending })
    expect(messageText(result.current.messages.at(-1))).toBe('chat.error')
    expect(result.current.messages.at(-1)?.answer.segments).toEqual([{ text: "chat.error", sourceIds: [] }])
    expect(result.current.messages.at(-1)?.answer.sources).toEqual([])

    const nextSource = { ...source, video_id: 8, title: 'Next source' }
    vi.mocked(apiClient.chatStream).mockImplementationOnce(async function* () {
      yield { type: 'source', source: nextSource }
      yield { type: 'text_delta', segmentIndex: 0, text: 'Next' }
      yield { type: 'citation', segmentIndex: 0, sourceId: 1 }
      yield { type: 'done', chat_log_id: 42, feedback: null }
    })
    act(() => result.current.setInput('retry'))
    await act(async () => { await result.current.handleSend() })
    expect(result.current.messages.at(-1)).toMatchObject({
      answer: { segments: [{ text: 'Next', sourceIds: [1] }], sources: [nextSource] }, chatLogId: 42,
    })
    expect(messageText(result.current.messages.at(-3))).toBe('chat.error')
    expect(result.current.isLoading).toBe(false)
  })

  it('sets isLoading to false after streaming completes', async () => {
    ;(apiClient.chatStream as any).mockImplementation(makeStreamMock(['Done']))

    const { result } = renderHook(() => useChatMessages({}))

    act(() => { result.current.setInput('Hi') })

    await act(async () => {
      await result.current.handleSend()
    })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
  })

  it.each([false, true])('shows intermediate text without duplication or mutating earlier state (StrictMode=%s)', async reactStrictMode => {
    const resolvers: Array<() => void> = []

    ;(apiClient.chatStream as any).mockImplementation(async function* () {
      yield { type: 'text_delta' as const, segmentIndex: 0, text: 'A' }
      // Pause — simulates network gap between tokens
      await new Promise<void>((resolve) => resolvers.push(resolve))
      yield { type: 'text_delta' as const, segmentIndex: 0, text: 'B' }
      yield { type: 'done' as const, chat_log_id: null, feedback: null }
    })

    const { result } = renderHook(() => useChatMessages({}), { reactStrictMode })
    act(() => { result.current.setInput('Hi') })

    // Start streaming without awaiting
    act(() => { void result.current.handleSend() })

    // First token should be visible before second arrives
    await waitFor(() => {
      expect(messageText(result.current.messages.at(-1))).toBe('A')
    })
    const firstPartialMessage = result.current.messages.at(-1)

    // Release second token
    act(() => { resolvers[0]?.() })

    // Both tokens should now be visible
    await waitFor(() => {
      expect(messageText(result.current.messages.at(-1))).toBe('AB')
    })
    expect(messageText(firstPartialMessage)).toBe('A')
    expect(apiClient.chatStream).toHaveBeenCalledTimes(1)
  })

  it('renders all received text in the next animation frame without a typing delay', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(apiClient.chatStream).mockImplementation(makeStreamMock(['ABCDEF']))

      const { result } = renderHook(() => useChatMessages({}))

      act(() => { result.current.setInput('Hi') })

      act(() => { void result.current.handleSend() })

      // Let the async generator deliver its events without advancing a frame.
      await act(async () => {})
      expect(messageText(result.current.messages.at(-1))).toBe('')
      expect(result.current.isLoading).toBe(true)
      await act(async () => {
        vi.advanceTimersToNextFrame()
      })
      expect(messageText(result.current.messages.at(-1))).toBe('ABCDEF')
      expect(result.current.isLoading).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['before request', 'after done'])('allows another question without a frame when hidden %s', async hiddenAt => {
    vi.useFakeTimers()
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(hiddenAt === 'before request')
    try {
      vi.mocked(apiClient.chatStream)
        .mockImplementationOnce(makeStreamMock(['First'], { chat_log_id: 41 }))
        .mockImplementationOnce(makeStreamMock(['Second'], { chat_log_id: 42 }))
      const { result } = renderHook(() => useChatMessages({}))
      act(() => result.current.setInput('First question'))
      let sending!: Promise<void>
      await act(async () => { sending = result.current.handleSend() })
      if (hiddenAt === 'after done') {
        expect(result.current.isLoading).toBe(true)
        expect(messageText(result.current.messages.at(-1))).toBe('')
        hidden.mockReturnValue(true)
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      }
      await act(async () => { await sending })
      expect(messageText(result.current.messages.at(-1))).toBe('First')
      expect(result.current.messages.at(-1)?.chatLogId).toBe(41)
      expect(result.current.isLoading).toBe(false)

      act(() => result.current.setInput('Second question'))
      await act(async () => { await result.current.handleSend() })
      expect(apiClient.chatStream).toHaveBeenCalledTimes(2)
      expect(messageText(result.current.messages.at(-3))).toBe('First')
      expect(messageText(result.current.messages.at(-1))).toBe('Second')
      expect(result.current.messages.at(-1)?.chatLogId).toBe(42)
      expect(result.current.isLoading).toBe(false)
    } finally {
      hidden.mockRestore()
      vi.useRealTimers()
    }
  })

  it('calls chatStream with courseId when provided', async () => {
    ;(apiClient.chatStream as any).mockImplementation(makeStreamMock(['ok']))

    const { result } = renderHook(() => useChatMessages({ courseId: 5 }))

    act(() => { result.current.setInput('Hi') })

    await act(async () => {
      await result.current.handleSend()
    })

    await waitFor(() => {
      expect(apiClient.chatStream).toHaveBeenCalledWith(
        expect.objectContaining({ course_id: 5 }),
        expect.any(AbortSignal),
      )
    })
  })

  it.each([
    { courseId: 5 },
    { courseId: 5, shareToken: 'shared' },
    {},
  ])('sends only the latest Q&A question while retaining visible messages (%j)', async (scope) => {
    vi.mocked(apiClient.chatStream).mockImplementation(makeStreamMock([]))
    const { result } = renderHook(() => useChatMessages(scope))
    const prior = [
      { role: 'user' as const, content: '内積とは？' },
      { role: 'assistant' as const, answer: { segments: [{ text: 'ベクトルの内積は…', sourceIds: [] }], sources: [] } },
    ]
    act(() => {
      result.current.setMessages(prior)
      result.current.setInput('具体例を教えて')
    })
    await act(async () => { await result.current.handleSend() })
    expect(apiClient.chatStream).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: '具体例を教えて' }],
      }),
      expect.any(AbortSignal),
    )
    expect(result.current.messages.slice(0, 2)).toEqual(prior)
  })

  it('guards against rapid consecutive sends before loading state rerenders', async () => {
    const resolvers: Array<() => void> = []
    ;(apiClient.chatStream as any).mockImplementation(async function* () {
      await new Promise<void>((resolve) => resolvers.push(resolve))
      yield { type: 'done' as const, chat_log_id: null, feedback: null }
    })

    const { result } = renderHook(() => useChatMessages({}))

    act(() => { result.current.setInput('Hi') })

    await waitFor(() => {
      expect(result.current.input).toBe('Hi')
    })

    act(() => {
      void result.current.handleSend()
      void result.current.handleSend()
    })

    await waitFor(() => {
      expect(apiClient.chatStream).toHaveBeenCalledTimes(1)
    })

    act(() => {
      resolvers[0]?.()
    })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
  })

  it('toggles feedback back to null when the same feedback is selected', async () => {
    setFeedback.mockResolvedValue({
      chat_log_id: 42,
      feedback: null,
    })

    const { result } = renderHook(() => useChatMessages({ shareToken: 'shared' }))

    act(() => {
      result.current.setMessages([
        { role: 'assistant', answer: { segments: [{ text: 'Answer', sourceIds: [] }], sources: [] }, chatLogId: 42, feedback: 'good', feedbackToken: 'issued-answer-token' },
      ])
    })

    await act(async () => {
      await result.current.handleFeedback(42, 'good')
    })

    expect(setFeedback).toHaveBeenCalledWith({
      chatLogId: 42,
      feedback: null,
      shareSlug: 'shared',
      feedbackToken: 'issued-answer-token',
    })
    expect(result.current.messages[0].feedback).toBeNull()
    expect(result.current.feedbackUpdatingIds.size).toBe(0)
  })

  it('aborts an in-flight request and ignores late events after unmount', async () => {
    let resume!: () => void
    let signal!: AbortSignal
    const waiting = new Promise<void>(resolve => { resume = resolve })
    const closed = vi.fn()
    vi.mocked(apiClient.chatStream).mockImplementation(async function* (_, requestSignal) {
      signal = requestSignal!
      try {
        yield { type: 'searching', query: 'pending search', search_id: 1 }
        await waiting
        yield { type: 'text_delta', segmentIndex: 0, text: 'Late answer' }
      } finally { closed() }
    })
    const { result, unmount } = renderHook(() => useChatMessages({ courseId: 3 }))
    act(() => result.current.setInput('hello'))
    let sending!: Promise<void>
    act(() => { sending = result.current.handleSend() })
    await waitFor(() => expect(result.current.messages.at(-1)?.progress?.phase).toBe('searching'))
    const lastMessage = result.current.messages.at(-1)
    unmount()
    expect(signal.aborted).toBe(true)
    const requestFrame = vi.spyOn(globalThis, 'requestAnimationFrame')
    await act(async () => { resume(); await sending })
    expect(closed).toHaveBeenCalledTimes(1)
    expect(messageText(lastMessage)).toBe('')
    expect(requestFrame).not.toHaveBeenCalled()
    requestFrame.mockRestore()
  })

  it('finishes and closes the stream on done without waiting for more network events', async () => {
    const nextRead = vi.fn()
    const closed = vi.fn()
    vi.mocked(apiClient.chatStream).mockImplementation(async function* () {
      try {
        yield { type: 'text_delta', segmentIndex: 0, text: 'Done' }
        yield { type: 'done', chat_log_id: 42, feedback: null }
        nextRead()
        yield { type: 'text_delta', segmentIndex: 0, text: 'Unexpected late content' }
      } finally { closed() }
    })
    const { result } = renderHook(() => useChatMessages({ courseId: 3 }))
    act(() => result.current.setInput('hello'))
    await act(async () => { await result.current.handleSend() })
    expect(result.current.messages.at(-1)).toMatchObject({ answer: { segments: [{ text: 'Done', sourceIds: [] }] }, chatLogId: 42 })
    expect(result.current.isLoading).toBe(false)
    expect(nextRead).not.toHaveBeenCalled()
    expect(closed).toHaveBeenCalledTimes(1)
  })
})
