import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.unmock('@/lib/api')

const { authClientMock } = vi.hoisted(() => ({
  authClientMock: {
    signOut: vi.fn(() => Promise.resolve({ data: {}, error: null })),
  },
}))

vi.mock('@/lib/auth-client', () => ({
  AUTH_BASE_URL: 'http://localhost:8000',
  authClient: authClientMock,
}))

import { apiClient } from '../api'
import { TRPC_UNAUTHORIZED_EVENT } from '../trpc'
import i18n from '@/i18n/config'

// Helper: each entry is a complete SSE event.
function makeSSEResponse(lines: string[], status = 200): Response {
  const body = lines.join('\n\n') + '\n\n'
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body))
      controller.close()
    },
  })
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

// Helper: collect all events from chatStream
async function collectStreamEvents(data: Parameters<typeof apiClient.chatStream>[0]) {
  const events = []
  for await (const event of apiClient.chatStream(data)) {
    events.push(event)
  }
  return events
}

describe('apiClient.chatStream', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    ;(apiClient as any).baseUrl = 'http://localhost:8000/api'
  })

  it('sends the current UI language on every stream request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      makeSSEResponse(['data: {"type":"done","chat_log_id":null,"feedback":null}']),
    )
    const originalLanguage = i18n.language
    try {
      for (const language of ['en', 'ja']) {
        await i18n.changeLanguage(language)
        await collectStreamEvents({ messages: [{ role: 'user', content: 'hello' }] })
        const request = fetchSpy.mock.calls.at(-1)?.[1]
        expect(new Headers(request?.headers).get('Accept-Language')).toBe(language)
        expect(new Headers(request?.headers).get('Content-Type')).toBe('application/json')
      }
    } finally {
      await i18n.changeLanguage(originalLanguage)
    }
  })

  it('yields text_delta events from SSE stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeSSEResponse([
        'data: {"type":"text_delta","segmentIndex":0,"text":"Hello "}',
        'data: {"type":"text_delta","segmentIndex":0,"text":"World"}',
        'data: {"type":"done","chat_log_id":null,"feedback":null}',
      ]),
    )

    const events = await collectStreamEvents({
      messages: [{ role: 'user', content: 'hi' }],
    })

    const chunks = events.filter((e) => e.type === 'text_delta')
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual({ type: 'text_delta', segmentIndex: 0, text: 'Hello ' })
    expect(chunks[1]).toEqual({ type: 'text_delta', segmentIndex: 0, text: 'World' })
  })

  it('opts in to tool progress and decodes its events for shared chats', async () => {
    const start = { type: 'tool_progress', call_id: 1, tool: 'focus_clip', status: 'running' }
    const done = { type: 'done', chat_log_id: null, feedback: null }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeSSEResponse([start, done].map(event => `data: ${JSON.stringify(event)}`)),
    )
    const events = await collectStreamEvents({ messages: [{ role: 'user', content: 'hi' }], share_slug: 'public-course' })
    expect(events).toEqual([start, done])
    const url = new URL(fetchSpy.mock.calls[0][0] instanceof Request ? fetchSpy.mock.calls[0][0].url : fetchSpy.mock.calls[0][0].toString())
    expect(url.searchParams.get('tool_progress')).toBe('1')
    expect(url.searchParams.get('share_slug')).toBe('public-course')
  })

  it('yields done event with metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeSSEResponse([
        'data: {"type":"text_delta","segmentIndex":0,"text":"Hi"}',
        'data: {"type":"done","chat_log_id":42,"feedback":null}',
      ]),
    )

    const events = await collectStreamEvents({
      messages: [{ role: 'user', content: 'hi' }],
    })

    const done = events.find((e) => e.type === 'done')
    expect(done).toEqual({ type: 'done', chat_log_id: 42, feedback: null })
  })

  it('yields error event from SSE', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeSSEResponse([
        'data: {"type":"error","code":"LLM_CONFIGURATION_ERROR","message":"Invalid API key"}',
      ]),
    )

    const events = await collectStreamEvents({
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(events[0]).toEqual({
      type: 'error',
      code: 'LLM_CONFIGURATION_ERROR',
      message: 'Invalid API key',
    })
  })

  it('calls correct endpoint for course chat with share_slug', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeSSEResponse(['data: {"type":"done","chat_log_id":null,"feedback":null}']),
    )

    await collectStreamEvents({
      messages: [{ role: 'user', content: 'hi' }],
      share_slug: 'abc123',
    })

    const calledUrl = fetchSpy.mock.calls[0][0] as string
    expect(calledUrl).toContain('/chat/messages/stream')
    expect(calledUrl).toContain('share_slug=abc123')
    expect(fetchSpy.mock.calls[0][1]).toEqual(expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      headers: expect.not.objectContaining({ Authorization: expect.anything() }),
    }))
  })

  it('throws ApiError on non-200 HTTP response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Bad input' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(collectStreamEvents({
      messages: [{ role: 'user', content: '' }],
    })).rejects.toThrow()
  })

  it('reports an unauthorized stream without signing out the current session', async () => {
    const unauthorized = vi.fn()
    window.addEventListener(TRPC_UNAUTHORIZED_EVENT, unauthorized)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'AUTHENTICATION_FAILED', message: 'Expired' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(collectStreamEvents({
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow('Authentication failed')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:8000/api/chat/messages/stream?tool_progress=1')
    expect(unauthorized).toHaveBeenCalledTimes(1)
    expect(authClientMock.signOut).not.toHaveBeenCalled()
    window.removeEventListener(TRPC_UNAUTHORIZED_EVENT, unauthorized)
  })

  it('handles chunked SSE delivery across multiple reads', async () => {
    const encoder = new TextEncoder()
    // Split a single SSE line across two reads
    const part1 = 'data: {"type":"text_delta","segmentIndex":0'
    const part2 = ',"text":"split"}\n\ndata: {"type":"done","chat_log_id":null,"feedback":null}\n\n'

    let readCount = 0
    const stream = new ReadableStream({
      pull(controller) {
        if (readCount === 0) {
          controller.enqueue(encoder.encode(part1))
          readCount++
        } else if (readCount === 1) {
          controller.enqueue(encoder.encode(part2))
          readCount++
        } else {
          controller.close()
        }
      },
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    )

    const events = await collectStreamEvents({
      messages: [{ role: 'user', content: 'hi' }],
    })

    const chunks = events.filter((e) => e.type === 'text_delta')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual({ type: 'text_delta', segmentIndex: 0, text: 'split' })
  })

  it.each(['\n', '\r\n', '\r'])('decodes multiline SSE with %j line endings across UTF-8 byte boundaries', async (newline) => {
    const expected = [
      { type: 'text_delta', segmentIndex: 0, text: '日本語🙂' },
      { type: 'done', chat_log_id: 42, feedback: null },
    ];
    const data = '\uFEFF' + [
      ': heartbeat', '',
      'data:{"type":"text_delta",',
      'data: "segmentIndex":0,"text":"日本語🙂"}', '',
      `data:${JSON.stringify(expected[1])}`, '', '',
    ].join(newline);
    const bytes = new TextEncoder().encode(data);
    let index = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index));
        else controller.close();
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
    expect(await collectStreamEvents({ messages: [{ role: 'user', content: 'hi' }] })).toEqual(expected);
  });

  it.each(['', '\n', '\r', '\r\n'])('does not accept a done event cut off before its blank line: %j', async (ending) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data: {"type":"done","chat_log_id":42,"feedback":null}' + ending));
    expect(await collectStreamEvents({ messages: [{ role: 'user', content: 'hi' }] })).toEqual([
      { type: 'error', code: 'STREAM_INTERRUPTED', message: '' },
    ]);
  });

  it('uses the sole structured stream protocol and validates citation events', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeSSEResponse([
      'data: {"type":"source","source":{"id":1,"video_id":7,"title":"Video","start_time":"00:00:10","end_time":null}}',
      'data: {"type":"text_delta","segmentIndex":0,"text":"Answer"}',
      'data: {"type":"citation","segmentIndex":0,"sourceId":1}',
      'data: {"type":"done","chat_log_id":1,"feedback":null}',
    ]))
    const events = await collectStreamEvents({ messages: [{ role: 'user', content: 'Hi' }], share_slug: 'a+b' })
    expect(events.map((event) => event.type)).toEqual(['source', 'text_delta', 'citation', 'done'])
    const url = new URL(fetch.mock.calls[0][0] instanceof Request ? fetch.mock.calls[0][0].url : fetch.mock.calls[0][0].toString())
    expect(url.searchParams.has('stream_format')).toBe(false)
    expect(url.searchParams.get('share_slug')).toBe('a+b')
  })

  it.each([
    '{"type":"citation","segmentIndex":0,"sourceId":-1}',
    '{"type":"text_delta","text":"missing segment"}',
    '{"type":"future_event"}',
    '{"type":"text_delta",',
  ])('fails malformed stream data before a later done can mark it complete: %s', async (invalid) => {
    const cancel = vi.fn()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          'data: {"type":"text_delta","segmentIndex":0,"text":"Partial"}',
          `data: ${invalid}`,
          'data: {"type":"done","chat_log_id":42,"feedback":null}',
          '',
        ].join('\n\n')))
      },
      cancel,
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body))
    expect(await collectStreamEvents({ messages: [{ role: 'user', content: 'hi' }] })).toEqual([
      { type: 'text_delta', segmentIndex: 0, text: 'Partial' },
      { type: 'error', code: 'STREAM_INVALID', message: '' },
    ])
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })

  it('cancels the response body when a consumer stops at a terminal event', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"done","chat_log_id":42,"feedback":null}\n\n'))
      },
      cancel,
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body))
    const stream = apiClient.chatStream({ messages: [{ role: 'user', content: 'hi' }] })
    expect((await stream.next()).value).toMatchObject({ type: 'done' })
    await stream.return(undefined)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(body.locked).toBe(false)
  })

  it.each([
    [{ type: 'text_delta', segmentIndex: 1, text: 'Missing first segment' }],
    [{ type: 'text_delta', segmentIndex: 0, text: 'First' }, { type: 'text_delta', segmentIndex: 2, text: 'Gap' }],
    [{ type: 'text_delta', segmentIndex: 0, text: 'First' }, { type: 'text_delta', segmentIndex: 1, text: 'Second' }, { type: 'text_delta', segmentIndex: 0, text: 'Late' }],
    [{ type: 'citation', segmentIndex: 0, sourceId: 1 }],
    [{ type: 'text_delta', segmentIndex: 0, text: 'First' }, { type: 'citation', segmentIndex: 1, sourceId: 1 }],
    [{ type: 'text_delta', segmentIndex: 0, text: 'First' }, { type: 'citation', segmentIndex: 0, sourceId: 999 }],
  ])('rejects inconsistent segment or source references before rendering: %j', async (...parts) => {
    const source = { type: 'source', source: { id: 1, video_id: 7, title: 'Video', start_time: '00:00:10', end_time: null } }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeSSEResponse([
      ...[source, ...parts, { type: 'done', chat_log_id: 42, feedback: null }].map(event => `data: ${JSON.stringify(event)}`),
    ]))
    const events = await collectStreamEvents({ messages: [{ role: 'user', content: 'hi' }] })
    expect(events.at(-1)).toEqual({ type: 'error', code: 'STREAM_INVALID', message: '' })
    expect(events).not.toContainEqual(parts.at(-1))
    expect(events.some(event => event.type === 'done')).toBe(false)
  })

  it('accepts consecutive segments, empty segments and citations across progress events', async () => {
    const events = [
      { type: 'source', source: { id: 1, video_id: 7, title: 'Video', start_time: '00:00:10', end_time: null } },
      { type: 'text_delta', segmentIndex: 0, text: '' },
      { type: 'text_delta', segmentIndex: 1, text: 'First' },
      { type: 'searching', search_id: 1, query: 'More' },
      { type: 'citation', segmentIndex: 1, sourceId: 1 },
      { type: 'text_delta', segmentIndex: 2, text: 'Second' },
      { type: 'text_delta', segmentIndex: 2, text: ' sentence' },
      { type: 'done', chat_log_id: 42, feedback: null },
    ]
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeSSEResponse(events.map(event => `data: ${JSON.stringify(event)}`)))
    expect(await collectStreamEvents({ messages: [{ role: 'user', content: 'hi' }] })).toEqual(events)
  })

  it('reports an interrupted answer when the connection closes without done', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeSSEResponse([
      'data: {"type":"text_delta","segmentIndex":0,"text":"Partial answer"}',
    ]))
    expect(await collectStreamEvents({ messages: [{ role: 'user', content: 'hi' }] })).toEqual([
      { type: 'text_delta', segmentIndex: 0, text: 'Partial answer' },
      { type: 'error', code: 'STREAM_INTERRUPTED', message: '' },
    ])
  })

  it.each([200, 204])('reports an interrupted answer when HTTP %s has no response body', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }))

    expect(await collectStreamEvents({ messages: [{ role: 'user', content: 'hi' }] })).toEqual([
      { type: 'error', code: 'STREAM_INTERRUPTED', message: '' },
    ])
  })

  it('passes the abort signal to fetch and releases a reader interrupted while waiting', async () => {
    const request = new AbortController()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_, init) => {
      init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true })
      return new Response(body)
    })
    const stream = apiClient.chatStream({ messages: [{ role: 'user', content: 'hi' }] }, request.signal)
    const next = stream.next()
    const rejected = expect(next).rejects.toThrow('Aborted')
    await vi.waitFor(() => expect(body.locked).toBe(true))
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: request.signal }))
    request.abort()
    await rejected
    expect(body.locked).toBe(false)
  })
})
