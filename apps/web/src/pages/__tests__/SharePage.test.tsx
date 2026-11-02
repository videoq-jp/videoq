import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { useQueryClient } from '@tanstack/react-query'
import { trpc } from '@/lib/trpc'
import SharePage from '../SharePage'

const getSharedCourse = vi.fn()

const mockCourse = {
  id: 1,
  name: 'Shared Course',
  description: 'Shared Description',
  videos: [
    { id: 1, title: 'Shared Video 1', description: 'Desc 1', status: 'completed', file: 'video1.mp4', source_type: 'uploaded', order: 0 },
    { id: 2, title: 'Shared Video 2', description: '', status: 'completed', file: 'video2.mp4', source_type: 'uploaded', order: 1 },
  ],
}

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useParams: () => ({ token: 'test-share-token' }),
  }
})

vi.mock('@/components/chat/ChatPanel', () => ({
  ChatPanel: ({ onVideoPlay }: { onVideoPlay: (id: number, time: string) => void }) => (
    <div data-testid="chat-panel"><button onClick={() => onVideoPlay(1, '00:02:00')}>Play citation</button></div>
  ),
}))

describe('SharePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.__setTrpcHandler('courses.shared', getSharedCourse)
    getSharedCourse.mockResolvedValue(mockCourse)
  })

  afterEach(() => {
    globalThis.__setMockLanguage('en')
  })

  it('should render course name', async () => {
    render(<SharePage />)

    await waitFor(() => {
      expect(screen.getAllByText('Shared Course').length).toBeGreaterThan(0)
    })
  })

  it('should render video list', async () => {
    render(<SharePage />)

    const first = await screen.findByRole('button', { name: /Shared Video 1/ })
    const second = screen.getByRole('button', { name: /Shared Video 2/ })
    expect(first).toHaveAttribute('aria-pressed', 'true')
    expect(second).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(second)
    expect(first).toHaveAttribute('aria-pressed', 'false')
    expect(second).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps one chat panel mounted across responsive layouts and mobile tabs', async () => {
    render(<SharePage />)

    const panel = await screen.findByTestId('chat-panel')
    try {
      for (const width of [390, 1280, 390]) {
        vi.stubGlobal('innerWidth', width)
        fireEvent(window, new Event('resize'))
        expect(screen.getByTestId('chat-panel')).toBe(panel)
      }
      vi.stubGlobal('innerWidth', 390)
      fireEvent(window, new Event('resize'))
      for (const tab of ['videos', 'overview', 'assistant']) {
        fireEvent.click(screen.getByRole('tab', { name: `videos.shared.tabs.${tab}` }))
        expect(screen.getByRole('tab', { name: `videos.shared.tabs.${tab}` })).toHaveAttribute('aria-selected', 'true')
        expect(screen.getByTestId('chat-panel')).toBe(panel)
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('opens on the assistant tab and switches panels by keyboard', async () => {
    render(<SharePage />)

    const assistant = await screen.findByRole('tab', { name: 'videos.shared.tabs.assistant' })
    const videos = screen.getByRole('tab', { name: 'videos.shared.tabs.videos' })
    expect(assistant).toHaveAttribute('aria-selected', 'true')
    expect(assistant).toHaveAttribute('tabindex', '0')
    expect(videos).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('tabpanel', { name: 'videos.shared.tabs.assistant' })).toContainElement(screen.getByTestId('chat-panel'))
    expect(screen.queryByRole('tab', { name: 'videos.shared.tabs.overview' })).not.toBeInTheDocument()

    fireEvent.keyDown(assistant, { key: 'ArrowLeft' })
    expect(videos).toHaveAttribute('aria-selected', 'true')
    expect(videos).toHaveFocus()
    expect(screen.getByRole('tabpanel', { name: 'videos.shared.tabs.videos' })).not.toHaveClass('invisible')
    expect(screen.getByTestId('chat-panel').parentElement).toHaveClass('invisible')
    fireEvent.keyDown(videos, { key: 'End' })
    expect(assistant).toHaveFocus()
  })

  it('shows the overview under the player on desktop and in a tab on mobile', async () => {
    try {
      render(<SharePage />)
      expect(await screen.findByText('Desc 1')).toBeInTheDocument()
      expect(screen.getByText('Shared Description')).toBeInTheDocument()

      vi.stubGlobal('innerWidth', 390)
      fireEvent(window, new Event('resize'))
      const overview = screen.getByRole('tab', { name: 'videos.shared.tabs.overview' })
      expect(screen.getAllByText('Desc 1')).toHaveLength(1)
      fireEvent.click(overview)
      expect(screen.getByRole('tabpanel', { name: 'videos.shared.tabs.overview' })).toHaveTextContent('Desc 1')

      // Returning to desktop removes the tab, so the panel must fall back.
      vi.stubGlobal('innerWidth', 1280)
      fireEvent(window, new Event('resize'))
      expect(screen.getByRole('tab', { name: 'videos.shared.tabs.assistant' })).toHaveAttribute('aria-selected', 'true')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('omits the overview tab when nothing describes the course or video', async () => {
    getSharedCourse.mockResolvedValue({ ...mockCourse, description: '', videos: [{ ...mockCourse.videos[1] }] })
    try {
      vi.stubGlobal('innerWidth', 390)
      render(<SharePage />)
      await screen.findByRole('tab', { name: 'videos.shared.tabs.assistant' })
      expect(screen.queryByRole('tab', { name: 'videos.shared.tabs.overview' })).not.toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('scrolls the player back into view when a citation is played', async () => {
    getSharedCourse.mockResolvedValue({ ...mockCourse, videos: mockCourse.videos.map(video => ({
      ...video, file: null, source_type: 'youtube', youtube_embed_url: `https://www.youtube.com/embed/video${video.id}`,
    })) })
    const { container } = render(<SharePage />)
    const citation = await screen.findByRole('button', { name: 'Play citation' })
    const details = container.querySelector('main > section')!
    details.scrollTop = 300
    fireEvent.click(citation)
    expect(details.scrollTop).toBe(0)
  })

  it('should select first video by default', async () => {
    const { container } = render(<SharePage />)

    await waitFor(() => {
      // First video title should appear in player header
      const titles = screen.getAllByText('Shared Video 1')
      expect(titles.length).toBeGreaterThan(0)
    })
    const player = container.querySelector('video')!
    expect(new URL(player.src).searchParams.get('share_slug')).toBe('test-share-token')
  })

  it('keeps the player and chat mounted while the shared course refreshes', async () => {
    const { result } = renderHook(() => useQueryClient())
    const { container } = render(<SharePage />)
    const chat = await screen.findByTestId('chat-panel')
    const player = container.querySelector('video')!
    player.currentTime = 45
    let finish!: (course: typeof mockCourse) => void
    getSharedCourse.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    let refresh!: Promise<void>
    act(() => { refresh = result.current.invalidateQueries(trpc.courses.shared.pathFilter()) })
    await waitFor(() => expect(getSharedCourse).toHaveBeenCalledTimes(2))
    expect(container.querySelector('video')).toBe(player)
    expect(screen.getByTestId('chat-panel')).toBe(chat)
    await act(async () => { finish(mockCourse); await refresh })
    expect(container.querySelector('video')).toBe(player)
    expect(player.currentTime).toBe(45)
  })

  it('clears citation playback when manually selecting another YouTube video', async () => {
    getSharedCourse.mockResolvedValue({ ...mockCourse, videos: mockCourse.videos.map(video => ({
      ...video, file: null, source_type: 'youtube', youtube_embed_url: `https://www.youtube.com/embed/video${video.id}`,
    })) })
    const { container } = render(<SharePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Play citation' }))
    expect(container.querySelector('iframe')).toHaveAttribute('src', 'https://www.youtube.com/embed/video1?autoplay=1&start=120')
    fireEvent.click(screen.getByText('Shared Video 2'))
    expect(container.querySelector('iframe')).toHaveAttribute('src', 'https://www.youtube.com/embed/video2')
    fireEvent.click(screen.getByText('Shared Video 1'))
    expect(container.querySelector('iframe')).toHaveAttribute('src', 'https://www.youtube.com/embed/video1')
  })

  it('restarts YouTube playback each time the same citation is clicked', async () => {
    getSharedCourse.mockResolvedValue({ ...mockCourse, videos: mockCourse.videos.map(video => ({
      ...video, file: null, source_type: 'youtube', youtube_embed_url: `https://www.youtube.com/embed/video${video.id}`,
    })) })
    const { container, rerender } = render(<SharePage />)
    const citation = await screen.findByRole('button', { name: 'Play citation' })
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = container.querySelector('iframe')
      fireEvent.click(citation)
      const current = container.querySelector('iframe')
      expect(current).not.toBe(previous)
      expect(current).toHaveAttribute('src', 'https://www.youtube.com/embed/video1?autoplay=1&start=120')
      rerender(<SharePage />)
      expect(container.querySelector('iframe')).toBe(current)
    }
  })

  it('should load shared course on mount', async () => {
    render(<SharePage />)

    await waitFor(() => {
      expect(getSharedCourse).toHaveBeenCalledWith({ slug: 'test-share-token' })
    })
  })

  it('should not autoplay youtube video on initial render', async () => {
    const youtubeCourse = {
      ...mockCourse,
      videos: [
        {
          id: 1,
          title: 'Shared Video 1',
          description: 'Desc 1',
          status: 'completed',
          file: null,
          source_type: 'youtube' as const,
          youtube_embed_url: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
          order: 0,
        },
      ],
    }
    getSharedCourse.mockResolvedValue(youtubeCourse)

    const { container } = render(<SharePage />)

    await waitFor(() => {
      const iframe = container.querySelector('iframe')
      expect(iframe).not.toBeNull()
      expect(iframe?.getAttribute('src')).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ')
    })
  })


})

describe('SharePage - Error Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.__setTrpcHandler('courses.shared', getSharedCourse)
  })

  it('should display error message when share link is invalid', async () => {
    getSharedCourse.mockRejectedValue(new Error('Not found'))

    render(<SharePage />)

    await waitFor(() => {
      expect(screen.getByText('common.messages.shareLoadFailed')).toBeInTheDocument()
    })
  })
})

describe('SharePage - Empty Course', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.__setTrpcHandler('courses.shared', getSharedCourse)
    const emptyCourse = { ...mockCourse, videos: [] }
    getSharedCourse.mockResolvedValue(emptyCourse)
  })

  it('should display no videos message when course is empty', async () => {
    render(<SharePage />)

    await waitFor(() => {
      expect(screen.getByText('videos.shared.noVideos')).toBeInTheDocument()
    })
  })
})
