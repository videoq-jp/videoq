import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import { apiClient } from '@/lib/api'

const chatTrpcMocks = vi.hoisted(() => ({
  history: vi.fn(),
  feedback: vi.fn(),
}))

// Mock apiClient
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    apiClient: {
      chatStream: vi.fn(),
      exportChatHistoryCsv: vi.fn(),
    },
  }
})

// Helper: create async generator mock for chatStream
function makeStreamMock(
  response: { content: string; chat_log_id?: number; feedback?: 'good' | 'bad' | null; citations?: any[] }
) {
  return async function* () {
    for (const source of response.citations ?? []) yield { type: 'source' as const, source };
    yield { type: 'text_delta' as const, segmentIndex: 0, text: response.content };
    for (const source of response.citations ?? []) yield { type: 'citation' as const, segmentIndex: 0, sourceId: source.id };
    yield {
      type: 'done' as const,
      chat_log_id: response.chat_log_id ?? null,
      feedback: response.feedback ?? null,
    }
  }
}

// Mock window.open
const mockOpen = vi.fn()
window.open = mockOpen

// Helper: type in input and press Enter to send
async function sendMessage(input: HTMLElement, message: string) {
  fireEvent.change(input, { target: { value: message } })
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })
}

describe('ChatPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.__setTrpcHandler('chat.history', async (input) => {
      const data = await chatTrpcMocks.history(input)
      return { data, meta: { total: data.length, limit: 100, offset: 0 } }
    })
    globalThis.__setTrpcHandler('chat.feedback', chatTrpcMocks.feedback)
    ;(apiClient.chatStream as any).mockImplementation(
      makeStreamMock({ content: 'Test response', chat_log_id: 1, feedback: null }),
    )
  })

  it('should render greeting message', () => {
    render(<ChatPanel />)

    expect(screen.getByText(/chat.assistantGreeting/)).toBeInTheDocument()
  })

  it.each([
    { name: 'course', before: { courseId: 1 }, after: { courseId: 2 } },
    { name: 'share link', before: { courseId: 1, shareToken: 'first' }, after: { courseId: 1, shareToken: 'second' } },
    { name: 'access route', before: { courseId: 1 }, after: { courseId: 1, shareToken: 'first' } },
  ])('isolates a new $name from a pending reply', async ({ before, after }) => {
    let finishOld!: () => void
    const pending = new Promise<void>(resolve => { finishOld = resolve })
    let oldSignal: AbortSignal | undefined
    const oldSource = { id: 1, video_id: 7, title: 'Old source', start_time: '00:01:00', end_time: '00:02:00' }
    vi.mocked(apiClient.chatStream).mockImplementationOnce(async function* (_request, signal) {
      oldSignal = signal
      yield { type: 'source', source: oldSource }
      yield { type: 'text_delta', segmentIndex: 0, text: 'Old reply' }
      yield { type: 'citation', segmentIndex: 0, sourceId: 1 }
      await pending
      yield { type: 'text_delta', segmentIndex: 0, text: 'Late response from old course' }
      yield { type: 'done', chat_log_id: 71, feedback: null }
    })
    const { rerender } = render(<ChatPanel {...before} />)
    await act(async () => { await sendMessage(screen.getByLabelText('chat.placeholder'), 'Old course answer') })
    await screen.findByRole('button', { name: 'Old source 00:01:00' })
    expect(screen.getByLabelText('chat.placeholder')).toBeDisabled()

    rerender(<ChatPanel {...after} />)
    try {
      expect(oldSignal?.aborted).toBe(true)
      expect(screen.getByLabelText('chat.placeholder')).toBeEnabled()
      expect(screen.queryByText('Old course answer')).not.toBeInTheDocument()
      expect(screen.getByText('chat.assistantGreeting')).toBeInTheDocument()
    } finally {
      await act(async () => { finishOld(); await pending })
    }
    expect(screen.queryByText('Late response from old course')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Old source 00:01:00' })).not.toBeInTheDocument()
    vi.mocked(apiClient.chatStream).mockImplementationOnce(async function* () {
      yield { type: 'text_delta', segmentIndex: 0, text: 'New scope [1]' }
      yield { type: 'done', chat_log_id: 72, feedback: null }
    })
    await act(async () => { await sendMessage(screen.getByLabelText('chat.placeholder'), 'New course question') })
    await screen.findByText('New scope [1]')
    expect(screen.queryByRole('button', { name: 'Old source 00:01:00' })).not.toBeInTheDocument()
    await waitFor(() => expect(apiClient.chatStream).toHaveBeenCalledTimes(2))
    const request = vi.mocked(apiClient.chatStream).mock.calls[1][0]
    expect(request).toMatchObject({
      course_id: after.courseId,
      messages: [{ role: 'user', content: 'New course question' }],
    })
    expect(request.share_slug).toBe('shareToken' in after ? after.shareToken : undefined)
  })

  it('should send message when form is submitted', async () => {
    render(<ChatPanel />)

    const input = screen.getByLabelText(/chat.placeholder/)

    await act(async () => {
      await sendMessage(input, 'Test message')
    })

    await waitFor(() => {
      expect(apiClient.chatStream).toHaveBeenCalled()
    })
  })

  it('clears completed dialogue and a draft only when the chat scope changes', async () => {
    const { rerender } = render(<ChatPanel courseId={1} />)
    await act(async () => { await sendMessage(screen.getByLabelText('chat.placeholder'), 'Original question') })
    await waitFor(() => expect(screen.getByText('Test response')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByLabelText('chat.placeholder')).toBeEnabled())
    fireEvent.change(screen.getByLabelText('chat.placeholder'), { target: { value: 'Unsent draft' } })
    rerender(<ChatPanel courseId={1} className="h-[600px]" onVideoPlay={vi.fn()} />)
    expect(screen.getByText('Original question')).toBeInTheDocument()
    expect(screen.getByLabelText('chat.placeholder')).toHaveValue('Unsent draft')

    rerender(<ChatPanel courseId={2} />)
    expect(screen.getByLabelText('chat.placeholder')).toHaveValue('')
    expect(screen.queryByText('Original question')).not.toBeInTheDocument()
    expect(screen.queryByText('Test response')).not.toBeInTheDocument()
    expect(screen.getByText('chat.assistantGreeting')).toBeInTheDocument()
  })

  it('should not send message when input is empty', async () => {
    render(<ChatPanel />)

    const input = screen.getByLabelText(/chat.placeholder/)

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })
    })

    expect(apiClient.chatStream).not.toHaveBeenCalled()
  })

  it('should open history when history button is clicked', async () => {
    chatTrpcMocks.history.mockResolvedValue([])

    render(<ChatPanel courseId={1} />)

    const historyButton = screen.getByText(/chat.history/)

    await act(async () => {
      fireEvent.click(historyButton)
    })

    await waitFor(() => {
      expect(chatTrpcMocks.history).toHaveBeenCalledWith({ courseId: 1, limit: 100, offset: 0 })
    })
  })

  it('should not show history button when shareToken is provided', () => {
    render(<ChatPanel courseId={1} shareToken="token123" />)

    expect(screen.queryByText(/chat.history/)).not.toBeInTheDocument()
  })

  it('fills the composer when a suggested question is clicked', () => {
    render(<ChatPanel courseId={1} shareToken="token123" suggestedQuestions={['CNNとは？']} />)

    fireEvent.click(screen.getByRole('button', { name: 'CNNとは？' }))

    expect(screen.getByLabelText(/chat.placeholder/)).toHaveValue('CNNとは？')
  })

  it('sends a suggested question on click when asked to', async () => {
    vi.mocked(apiClient.chatStream).mockImplementation(async function* () {
      yield { type: 'done', chat_log_id: 1, feedback: null }
    })
    render(<ChatPanel courseId={1} shareToken="token123" suggestedQuestions={['CNNとは？']} sendSuggestedQuestions />)

    fireEvent.click(screen.getByRole('button', { name: 'CNNとは？' }))

    await waitFor(() => expect(apiClient.chatStream).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [expect.objectContaining({ content: 'CNNとは？' })], share_slug: 'token123' }),
      expect.anything(),
    ))
  })

  it('shows clickable timestamps while the response is still streaming', async () => {
    const onVideoPlay = vi.fn()
    const citations = [{ id: 1, video_id: 1, title: 'Test Video', start_time: '00:01:30', end_time: '00:15:30' }]
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    vi.mocked(apiClient.chatStream).mockImplementation(async function* () {
      yield { type: 'source', source: citations[0] }
      yield { type: 'text_delta', segmentIndex: 0, text: 'AB' }
      yield { type: 'citation', segmentIndex: 0, sourceId: 1 }
      yield { type: 'text_delta', segmentIndex: 0, text: '続き' }
      await pending
      yield { type: 'done', chat_log_id: 1, feedback: null }
    })

    render(<ChatPanel onVideoPlay={onVideoPlay} />)
    const input = screen.getByLabelText(/chat.placeholder/)
    await act(async () => { await sendMessage(input, 'Test') })
    try {
      const reference = await screen.findByRole('button', { name: 'Test Video 00:01:30' })
      expect(reference).toHaveTextContent('(1:30-15:30)')
      expect(screen.queryByText(/\[1\]/)).not.toBeInTheDocument()
      expect(input).toBeDisabled()
      expect(screen.queryByRole('button', { name: 'chat.feedbackGood' })).not.toBeInTheDocument()
      fireEvent.click(reference)
      expect(onVideoPlay).toHaveBeenCalledWith(1, '00:01:30')
    } finally {
      await act(async () => { finish(); await pending })
    }
    await waitFor(() => expect(input).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Test Video 00:01:30' })).toHaveTextContent('(1:30-15:30)')
    expect(screen.getByRole('button', { name: 'chat.feedbackGood' })).toBeInTheDocument()
  })

  it('should handle video navigation', async () => {
    const onVideoPlay = vi.fn()
    ;(apiClient.chatStream as any).mockImplementation(makeStreamMock({
      content: 'This is grounded text.',
      citations: [{ id: 1, video_id: 1, title: 'Test Video', start_time: '00:01:30', end_time: '00:15:30' }],
      chat_log_id: 1,
      feedback: null,
    }))

    render(<ChatPanel onVideoPlay={onVideoPlay} />)

    const input = screen.getByLabelText(/chat.placeholder/)

    await act(async () => {
      await sendMessage(input, 'Test')
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Test Video 00:01:30/ })).toBeInTheDocument()
    })
    expect(screen.getByText((text) => text.includes('This is grounded text'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Test Video 00:01:30/ })).toHaveTextContent('(1:30-15:30)')

    const videoButton = screen.getByTitle(/Test Video/)
    if (videoButton) {
      await act(async () => {
        fireEvent.click(videoButton)
      })
      expect(onVideoPlay).toHaveBeenCalledWith(1, '00:01:30')
    }
  })

  it('should open video in new tab when onVideoPlay is not provided', async () => {
    ;(apiClient.chatStream as any).mockImplementation(makeStreamMock({
      content: 'This is grounded text.',
      citations: [{ id: 1, video_id: 1, title: 'Test Video', start_time: '00:01:30', end_time: '00:15:30' }],
      chat_log_id: 1,
      feedback: null,
    }))

    render(<ChatPanel />)

    const input = screen.getByLabelText(/chat.placeholder/)

    await act(async () => {
      await sendMessage(input, 'Test')
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Test Video 00:01:30/ })).toBeInTheDocument()
    })

    const videoButton = screen.getByTitle(/Test Video/)
    if (videoButton) {
      await act(async () => {
        fireEvent.click(videoButton)
      })
      expect(mockOpen).toHaveBeenCalledWith('/videos/1?t=90', '_blank')
    }
  })

  it('should send message when Enter key is pressed', async () => {
    render(<ChatPanel />)

    const input = screen.getByLabelText(/chat.placeholder/)

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Test message' } })
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })
    })

    await waitFor(() => {
      expect(apiClient.chatStream).toHaveBeenCalled()
    })
  })

  it('should not send message when Shift+Enter is pressed', async () => {
    render(<ChatPanel />)

    const input = screen.getByLabelText(/chat.placeholder/)

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Test message' } })
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    })

    expect(apiClient.chatStream).not.toHaveBeenCalled()
  })

  it('should handle feedback good button click', async () => {
    ;(apiClient.chatStream as any).mockImplementation(
      makeStreamMock({ content: 'Response', chat_log_id: 1, feedback: null }),
    )
    chatTrpcMocks.feedback.mockResolvedValue({
      chat_log_id: 1,
      feedback: 'good',
    })

    render(<ChatPanel />)

    const input = screen.getByLabelText(/chat.placeholder/)

    await act(async () => {
      await sendMessage(input, 'Test')
    })

    // Wait for assistant response with feedback buttons
    await waitFor(() => {
      expect(screen.getByText('Response')).toBeInTheDocument()
    })

    const goodButton = await screen.findByRole('button', { name: 'chat.feedbackGood' })
    await act(async () => {
      fireEvent.click(goodButton)
    })

    await waitFor(() => {
      expect(chatTrpcMocks.feedback).toHaveBeenCalledWith({ chatLogId: 1, feedback: 'good' })
    })
  })

  it('should handle feedback bad button click', async () => {
    ;(apiClient.chatStream as any).mockImplementation(
      makeStreamMock({ content: 'Response', chat_log_id: 1, feedback: null }),
    )
    chatTrpcMocks.feedback.mockResolvedValue({
      chat_log_id: 1,
      feedback: 'bad',
    })

    render(<ChatPanel />)

    const input = screen.getByLabelText(/chat.placeholder/)

    await act(async () => {
      await sendMessage(input, 'Test')
    })

    await waitFor(() => {
      expect(screen.getByText('Response')).toBeInTheDocument()
    })

    const thumbsDownButtons = screen.getAllByRole('button').filter(
      btn => btn.querySelector('[class*="lucide-thumbs-down"]')
    )

    if (thumbsDownButtons.length > 0) {
      await act(async () => {
        fireEvent.click(thumbsDownButtons[0])
      })

      await waitFor(() => {
        expect(chatTrpcMocks.feedback).toHaveBeenCalledWith({ chatLogId: 1, feedback: 'bad' })
      })
    }
  })

  it('should toggle feedback when clicking same button', async () => {
    ;(apiClient.chatStream as any).mockImplementation(
      makeStreamMock({ content: 'Response', chat_log_id: 1, feedback: 'good' }),
    )
    chatTrpcMocks.feedback.mockResolvedValue({
      chat_log_id: 1,
      feedback: null,
    })

    render(<ChatPanel />)

    const input = screen.getByLabelText(/chat.placeholder/)

    await act(async () => {
      await sendMessage(input, 'Test')
    })

    await waitFor(() => {
      expect(screen.getByText('Response')).toBeInTheDocument()
    })

    const thumbsUpButtons = screen.getAllByRole('button').filter(
      btn => btn.querySelector('[class*="lucide-thumbs-up"]')
    )

    if (thumbsUpButtons.length > 0) {
      await act(async () => {
        fireEvent.click(thumbsUpButtons[0])
      })

      await waitFor(() => {
        expect(chatTrpcMocks.feedback).toHaveBeenCalledWith({ chatLogId: 1, feedback: null })
      })
    }
  })

  it('keeps each answer disabled until its own feedback save completes', async () => {
    vi.mocked(apiClient.chatStream)
      .mockImplementationOnce(makeStreamMock({ content: 'First answer', chat_log_id: 42 }))
      .mockImplementationOnce(makeStreamMock({ content: 'Second answer', chat_log_id: 43 }))
    let finishFirst!: (value: { chat_log_id: number; feedback: 'good' }) => void
    chatTrpcMocks.feedback
      .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
      .mockResolvedValue({ chat_log_id: 43, feedback: 'bad' })
    render(<ChatPanel courseId={1} />)
    const input = screen.getByLabelText('chat.placeholder')
    await act(async () => { await sendMessage(input, 'First') })
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'chat.feedbackGood' })).toHaveLength(1))
    await act(async () => { await sendMessage(input, 'Second') })
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'chat.feedbackGood' })).toHaveLength(2))
    const good = screen.getAllByRole('button', { name: 'chat.feedbackGood' })
    const bad = screen.getAllByRole('button', { name: 'chat.feedbackBad' })
    fireEvent.click(good[0])
    await waitFor(() => expect(chatTrpcMocks.feedback).toHaveBeenCalledTimes(1))
    try {
      expect(good[0]).toBeDisabled()
      expect(bad[0]).toBeDisabled()
      expect(bad[1]).toBeEnabled()
      fireEvent.click(bad[1])
      await waitFor(() => expect(bad[1]).toHaveAttribute('aria-pressed', 'true'))
      expect(bad[1]).toBeEnabled()
      expect(good[0]).toBeDisabled()
      expect(bad[0]).toBeDisabled()
    } finally {
      await act(async () => { finishFirst({ chat_log_id: 42, feedback: 'good' }) })
    }
    await waitFor(() => expect(good[0]).toHaveAttribute('aria-pressed', 'true'))
    expect(good[0]).toBeEnabled()
    expect(chatTrpcMocks.feedback).toHaveBeenCalledTimes(2)
  })

  it('should display history when opened', async () => {
    const mockHistory = [
      {
        id: 1,
        course: 1,
        asked_by: {
          user_id: 'student-user',
          username: 'student',
          email: 'student@example.com',
        },
        question: 'Test question',
        answer: { segments: [{ text: 'Test answer', sourceIds: [] }], sources: [] },
        is_shared_origin: false,
        created_at: '2024-01-15T10:00:00Z',
        feedback: null,
      },
      {
        id: 2,
        course: 1,
        asked_by: null,
        question: 'Shared question',
        answer: { segments: [{ text: 'Shared answer', sourceIds: [] }], sources: [] },
        is_shared_origin: true,
        created_at: '2024-01-15T10:01:00Z',
        feedback: null,
      },
    ]
    chatTrpcMocks.history.mockResolvedValue(mockHistory)

    render(<ChatPanel courseId={1} />)

    const historyButton = screen.getByText(/chat.history/)

    await act(async () => {
      fireEvent.click(historyButton)
    })

    await waitFor(() => {
      expect(screen.getByText('Test question')).toBeInTheDocument()
      expect(screen.getByText('Test answer')).toBeInTheDocument()
      expect(screen.getByText('student')).toBeInTheDocument()
      expect(screen.getByText('student@example.com')).toBeInTheDocument()
      expect(screen.getByText('chat.sharedLinkUser')).toBeInTheDocument()
    })
    expect(chatTrpcMocks.history).toHaveBeenCalledExactlyOnceWith({ courseId: 1, limit: 100, offset: 0 })
  })

  it('should switch back to chat tab from history', async () => {
    chatTrpcMocks.history.mockResolvedValue([])

    render(<ChatPanel courseId={1} />)

    // Switch to history tab
    const historyButton = screen.getByText(/chat.history/)
    await act(async () => {
      fireEvent.click(historyButton)
    })

    // Switch back to chat tab
    const chatButton = screen.getByText(/chat.newConsultation/)
    await act(async () => {
      fireEvent.click(chatButton)
    })

    // Should show chat input again
    expect(screen.getByLabelText(/chat.placeholder/)).toBeInTheDocument()
  })

  it('should export CSV when export button is clicked', async () => {
    const mockHistory = [
      {
        id: 1,
        course: 1,
        question: 'Test question',
        answer: { segments: [{ text: 'Test answer', sourceIds: [] }], sources: [] },
        is_shared_origin: false,
        created_at: '2024-01-15T10:00:00Z',
        feedback: null,
      },
    ]
    chatTrpcMocks.history.mockResolvedValue(mockHistory)
    ;(apiClient.exportChatHistoryCsv as any).mockResolvedValue(undefined)

    render(<ChatPanel courseId={1} />)

    const historyButton = screen.getByText(/chat.history/)

    await act(async () => {
      fireEvent.click(historyButton)
    })

    await waitFor(() => {
      expect(screen.getByText('Test question')).toBeInTheDocument()
    })

    // The export button shows CSV text
    await waitFor(() => {
      const buttons = screen.getAllByText(/chat.exportCsv/)
      expect(buttons.length).toBeGreaterThan(0)
    })

    const exportButtons = screen.getAllByText(/chat.exportCsv/)
    const exportButton = exportButtons[0].closest('button')

    if (exportButton) {
      await act(async () => {
        fireEvent.click(exportButton)
      })
    }

    await waitFor(() => {
      expect(apiClient.exportChatHistoryCsv).toHaveBeenCalledWith(1)
    })
  })

  it('shows preparation status in the bubble until the first token arrives', async () => {
    let releaseFirstChunk: () => void = () => {}
    const firstChunkGate = new Promise<void>((resolve) => {
      releaseFirstChunk = resolve
    })
    ;(apiClient.chatStream as any).mockImplementation(async function* () {
      await firstChunkGate
      yield { type: 'text_delta' as const, segmentIndex: 0, text: 'Streamed answer' }
      yield { type: 'done' as const, chat_log_id: 1, feedback: null }
    })

    render(<ChatPanel />)

    const input = screen.getByLabelText(/chat.placeholder/)

    await act(async () => {
      await sendMessage(input, 'Test message')
    })

    // The live region must carry the text itself: an aria-label would give it a
    // name but leave a screen reader with nothing to announce.
    const indicator = await screen.findByRole('status')
    expect(indicator).toHaveTextContent('chat.progress.preparing')
    expect(screen.getByText('chat.progress.preparing', { selector: 'span' })).toBeVisible()

    await act(async () => {
      releaseFirstChunk()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByText('Streamed answer')).toBeInTheDocument()
    })
    expect(screen.queryByText('chat.generating')).not.toBeInTheDocument()
  })

  it('drops the typing indicator when the stream ends without any text', async () => {
    ;(apiClient.chatStream as any).mockImplementation(async function* () {
      yield { type: 'done' as const, chat_log_id: 2, feedback: null }
    })

    render(<ChatPanel />)

    const input = screen.getByLabelText(/chat.placeholder/)

    await act(async () => {
      await sendMessage(input, 'Test message')
    })

    await waitFor(() => {
      expect(apiClient.chatStream).toHaveBeenCalled()
    })
    // The bubble stays empty, but an indicator that never stops would claim the
    // answer is still being generated.
    await waitFor(() => {
      expect(screen.queryByText('chat.generating')).not.toBeInTheDocument()
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })
  })

  it('replaces preparation with the actual tool before any answer text arrives', async () => {
    let finishTool!: () => void
    const toolGate = new Promise<void>(resolve => { finishTool = resolve })
    vi.mocked(apiClient.chatStream).mockImplementation(async function* () {
      yield { type: 'tool_progress', call_id: 1, tool: 'focus_clip', status: 'running' }
      await toolGate
      yield { type: 'tool_progress', call_id: 1, tool: 'focus_clip', status: 'complete' }
      yield { type: 'text_delta', segmentIndex: 0, text: '映像の回答' }
      yield { type: 'done', chat_log_id: 1, feedback: null }
    })
    render(<ChatPanel />)
    await act(async () => { await sendMessage(screen.getByLabelText(/chat.placeholder/), '映像を確認して') })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('focus_clip'))
    expect(screen.getByRole('status')).not.toHaveTextContent('chat.progress.preparing')
    expect(screen.queryByText('映像の回答')).not.toBeInTheDocument()
    await act(async () => { finishTool() })
    await waitFor(() => expect(screen.getByText('映像の回答')).toBeVisible())
    fireEvent.click(screen.getByRole('button', { name: /chat.progress.details/ }))
    expect(screen.getByText('focus_clip', { selector: 'code' })).toBeVisible()
    expect(screen.getByText('chat.progress.toolStatus.complete')).toBeVisible()
  })

  it('should display error message when chat fails', async () => {
    ;(apiClient.chatStream as any).mockImplementation(async function* () {
      throw new Error('Chat failed')
      yield // make it a generator
    })

    render(<ChatPanel />)

    const input = screen.getByLabelText(/chat.placeholder/)

    await act(async () => {
      await sendMessage(input, 'Test message')
    })

    await waitFor(() => {
      expect(screen.getByText(/chat.error/)).toBeInTheDocument()
    })
  })

  it('should handle history loading state', async () => {
    chatTrpcMocks.history.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve([]), 100))
    )

    render(<ChatPanel courseId={1} />)

    const historyButton = screen.getByText(/chat.history/)

    await act(async () => {
      fireEvent.click(historyButton)
    })

    // Loading state shows a spinner, history is empty loading
    // The history view renders while loading
    expect(screen.queryByText('Test question')).not.toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
  })

  it('should handle getChatHistory error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    chatTrpcMocks.history.mockRejectedValue(new Error('Failed to load history'))

    render(<ChatPanel courseId={1} />)

    const historyButton = screen.getByText(/chat.history/)

    await act(async () => {
      fireEvent.click(historyButton)
    })

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to load history', expect.any(Error))
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load history')
    expect(screen.queryByText('chat.historyEmpty')).not.toBeInTheDocument()

    consoleErrorSpy.mockRestore()
  })

  it('should handle exportChatHistoryCsv error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mockHistory = [
      {
        id: 1,
        course: 1,
        question: 'Test question',
        answer: { segments: [{ text: 'Test answer', sourceIds: [] }], sources: [] },
        is_shared_origin: false,
        created_at: '2024-01-15T10:00:00Z',
        feedback: null,
      },
    ]
    chatTrpcMocks.history.mockResolvedValue(mockHistory)
    ;(apiClient.exportChatHistoryCsv as any).mockRejectedValue(new Error('Failed to export CSV'))

    render(<ChatPanel courseId={1} />)

    const historyButton = screen.getByText(/chat.history/)

    await act(async () => {
      fireEvent.click(historyButton)
    })

    await waitFor(() => {
      expect(screen.getByText('Test question')).toBeInTheDocument()
    })

    const exportButtons = screen.getAllByText(/chat.exportCsv/)
    const exportButton = exportButtons[0].closest('button')

    if (exportButton) {
      await act(async () => {
        fireEvent.click(exportButton)
      })
    }

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to export CSV', expect.any(Error))
    })

    consoleErrorSpy.mockRestore()
  })

  it('should handle setChatFeedback error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(apiClient.chatStream as any).mockImplementation(
      makeStreamMock({ content: 'Response', chat_log_id: 1, feedback: null }),
    )
    chatTrpcMocks.feedback.mockRejectedValue(new Error('Failed to update feedback'))

    render(<ChatPanel />)

    const input = screen.getByLabelText(/chat.placeholder/)

    await act(async () => {
      await sendMessage(input, 'Test')
    })

    await waitFor(() => {
      expect(screen.getByText('Response')).toBeInTheDocument()
    })

    const thumbsUpButtons = screen.getAllByRole('button').filter(
      btn => btn.querySelector('[class*="lucide-thumbs-up"]')
    )

    if (thumbsUpButtons.length > 0) {
      await act(async () => {
        fireEvent.click(thumbsUpButtons[0])
      })

      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to update feedback', expect.any(Error))
      })
    }

    consoleErrorSpy.mockRestore()
  })

  it('should not send message when Enter key is pressed during composition', async () => {
    render(<ChatPanel />)

    const input = screen.getByLabelText(/chat.placeholder/)

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Test message' } })
      // Simulate composition event
      const compositionEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
      })
      Object.defineProperty(compositionEvent, 'nativeEvent', {
        value: { isComposing: true },
      })
      input.dispatchEvent(compositionEvent)
    })

    // Should not call chat API during composition
    expect(apiClient.chatStream).not.toHaveBeenCalled()
  })

  it('should display citation timestamps in history', async () => {
    const mockHistory = [
      {
        id: 1,
        course: 1,
        question: 'Test question',
        answer: { segments: [{ text: "Test answer", sourceIds: [1] }], sources: [
          {
            id: 1,
            video_id: 1,
            title: 'History Video',
            start_time: '00:02:00',
            end_time: '00:10:00',
          },
        ] },

        is_shared_origin: false,
        created_at: '2024-01-15T10:00:00Z',
        feedback: null,
      },
    ]
    chatTrpcMocks.history.mockResolvedValue(mockHistory)

    render(<ChatPanel courseId={1} />)

    const historyButton = screen.getByText(/chat.history/)

    await act(async () => {
      fireEvent.click(historyButton)
    })

    await waitFor(() => {
      expect(screen.getByText('Test question')).toBeInTheDocument()
    })

    expect(screen.getByText((text) => text.includes('Test answer'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /History Video 00:02:00/ })).toHaveTextContent('(2:00-10:00)')
  })

  it('should render multiple reference ids as separate buttons', async () => {
    ;(apiClient.chatStream as any).mockImplementation(makeStreamMock({
      content: 'This is grounded text.',
      citations: [
        { id: 1, video_id: 1, title: 'Video One', start_time: '00:01:30', end_time: '00:15:30' },
        { id: 2, video_id: 2, title: 'Video Two', start_time: '00:02:30', end_time: '00:08:30' },
      ],
      chat_log_id: 1,
      feedback: null,
    }))

    render(<ChatPanel />)

    const input = screen.getByLabelText(/chat.placeholder/)

    await act(async () => {
      await sendMessage(input, 'Test')
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Video One 00:01:30/ })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Video Two 00:02:30/ })).toBeInTheDocument()
    })

    expect(screen.getByTitle(/Video One 00:01:30/)).toBeInTheDocument()
    expect(screen.getByTitle(/Video Two 00:02:30/)).toBeInTheDocument()
    expect(screen.getByText((text) => text.includes('This is grounded text'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Video One 00:01:30/ })).toHaveTextContent('(1:30-15:30)')
    expect(screen.getByRole('button', { name: /Video Two 00:02:30/ })).toHaveTextContent('(2:30-8:30)')
  })

  it('should keep unmatched citation markers as plain text', async () => {
    ;(apiClient.chatStream as any).mockImplementation(
      makeStreamMock({ content: 'Response [2]', chat_log_id: 1, feedback: null }),
    )

    render(<ChatPanel />)

    const input = screen.getByLabelText(/chat.placeholder/)

    await act(async () => {
      await sendMessage(input, 'Test')
    })

    await waitFor(() => {
      expect(screen.getByText('Response [2]')).toBeInTheDocument()
    })
  })
})
