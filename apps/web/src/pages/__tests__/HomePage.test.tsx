import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import HomePage from '../HomePage'
import { useI18nNavigate } from '@/lib/i18n'

const mockUseVideoStatusCounts = vi.hoisted(() => vi.fn())
const getAccount = vi.fn()
const listVideos = vi.fn()
const listCourses = vi.fn()
const chatHistory = vi.fn()

beforeEach(() => {
  globalThis.__setTrpcHandler('account.me', getAccount)
  globalThis.__setTrpcHandler('videos.list', listVideos)
  globalThis.__setTrpcHandler('courses.list', listCourses)
  globalThis.__setTrpcHandler('chat.history', chatHistory)
  chatHistory.mockResolvedValue({ data: [{ id: 1 }], meta: { total: 1, limit: 1, offset: 0 } })
})

vi.mock('@/hooks/useVideoStats', () => ({
  useVideoStatusCounts: mockUseVideoStatusCounts,
}))

let mockNavigate: ReturnType<typeof vi.fn>

const mockVideos = [
  { id: 1, title: 'Video 1', status: 'completed', file: 'v1.mp4', uploaded_at: '2024-01-03T00:00:00Z' },
  { id: 2, title: 'Video 2', status: 'pending', file: 'v2.mp4', uploaded_at: '2024-01-02T00:00:00Z' },
  { id: 3, title: 'Video 3', status: 'processing', file: 'v3.mp4', uploaded_at: '2024-01-01T00:00:00Z' },
  { id: 4, title: 'Video 4', status: 'indexing', file: 'v4.mp4', uploaded_at: '2024-01-04T00:00:00Z' },
  { id: 5, title: 'Video 5', status: 'error', file: 'v5.mp4', uploaded_at: '2024-01-05T00:00:00Z' },
]

const mockCourses = [
  { id: 1, name: 'Course 1', video_count: 2, access_role: 'owner' },
  { id: 2, name: 'Course 2', video_count: 3, access_role: 'owner' },
]

describe('HomePage - authenticated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNavigate = useI18nNavigate() as ReturnType<typeof vi.fn>
    getAccount.mockResolvedValue({
      id: 1,
      username: 'testuser',
      used_storage_bytes: 2.5 * 1024 ** 3,
      storage_limit_bytes: 10 * 1024 ** 3,
      used_processing_seconds: 65 * 60,
      processing_limit_seconds: 180 * 60,
      used_ai_answers: 12,
      ai_answers_limit: 100,
      is_over_quota: false,
    })
    listVideos.mockResolvedValue({
      data: mockVideos,
      meta: { total: mockVideos.length, limit: 24, offset: 0 },
    })
    listCourses.mockResolvedValue({
      data: mockCourses,
      meta: { total: mockCourses.length, limit: 1, offset: 0 },
    })
    mockUseVideoStatusCounts.mockReturnValue({
      stats: {
        total: 24,
        completed: 20,
        pending: 0,
        processing: 0,
        indexing: 0,
        error: 0,
        uploading: 0,
      },
      isLoading: false,
      error: null,
    })
  })

  it('should render welcome title', async () => {
    render(<HomePage />)

    await waitFor(() => {
      expect(screen.getByText('home.welcome.greeting {"username":"testuser"}')).toBeInTheDocument()
    })
  })

  it('should render welcome subtitle', async () => {
    render(<HomePage />)

    await waitFor(() => {
      expect(screen.getByText('home.welcome.dailyMotivation')).toBeInTheDocument()
    })
  })

  it('should render upload action card', async () => {
    render(<HomePage />)

    await waitFor(() => {
      expect(screen.getAllByText('home.actions.upload.title').length).toBeGreaterThan(0)
      expect(screen.getByText('home.actions.upload.descriptionLong')).toBeInTheDocument()
    })
  })

  it('should render library action card', async () => {
    render(<HomePage />)

    await waitFor(() => {
      expect(screen.getByText('home.actions.library.title')).toBeInTheDocument()
    })
  })

  it('should render courses action card', async () => {
    render(<HomePage />)

    await waitFor(() => {
      expect(screen.getByText('home.actions.courses.title')).toBeInTheDocument()
    })
  })

  it('should not render the redundant courses tip', async () => {
    render(<HomePage />)

    await waitFor(() => {
      expect(screen.getByText('home.actions.courses.title')).toBeInTheDocument()
    })

    expect(screen.queryByText('home.tips.hint')).not.toBeInTheDocument()
    expect(screen.queryByText('home.tips.message')).not.toBeInTheDocument()
  })

  it('should not show the getting started guide once every step is done', async () => {
    render(<HomePage />)

    await screen.findByText('home.stats.summaryTitle')
    expect(screen.queryByText('home.gettingStarted.title')).not.toBeInTheDocument()
  })

  it('should render stats cards', async () => {
    render(<HomePage />)

    await waitFor(() => {
      expect(screen.getByText('home.stats.totalVideos')).toBeInTheDocument()
      expect(screen.getByText('home.stats.analysisCompleted')).toBeInTheDocument()
      expect(screen.getByText('home.stats.processing')).toBeInTheDocument()
      expect(screen.getByText('home.stats.courses')).toBeInTheDocument()
    })
  })

  it('should show library-wide counts instead of the first video page', async () => {
    render(<HomePage />)

    await waitFor(() => {
      expect(screen.getByText('home.stats.totalVideos').parentElement).toHaveTextContent('24')
      expect(screen.getByText('home.stats.analysisCompleted').parentElement).toHaveTextContent('20')
    })
  })

  it('should render usage cards from the current user payload', async () => {
    render(<HomePage />)

    await waitFor(() => {
      expect(screen.getByText('home.usage.title')).toBeInTheDocument()
    })

    const storageCard = screen.getByText('quota.usage.storage').parentElement
    const transcriptionCard = screen.getByText('quota.usage.transcription').parentElement
    const aiAnswersCard = screen.getByText('quota.usage.aiAnswers').parentElement

    expect(storageCard?.textContent).toContain('2.5')
    expect(storageCard?.textContent).toContain('10')
    expect(transcriptionCard?.textContent).toContain('65')
    expect(transcriptionCard?.textContent).toContain('180')
    expect(aiAnswersCard?.textContent).toContain('12')
    expect(aiAnswersCard?.textContent).toContain('100')
  })

  it('should navigate to videos page with upload param when upload button is clicked', async () => {
    render(<HomePage />)

    await waitFor(() => {
      expect(screen.getAllByText('home.actions.upload.title').length).toBeGreaterThan(0)
    })

    // Click the header upload button
    const uploadButtons = screen.getAllByText('home.actions.upload.title')
    fireEvent.click(uploadButtons[0])

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/videos?upload=true')
    })
  })

  it('should navigate to videos page when library card is clicked', async () => {
    render(<HomePage />)

    await waitFor(() => {
      expect(screen.getByText('home.actions.library.title')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('home.actions.library.title'))

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/videos')
    })
  })

  it('should navigate to courses page when courses card is clicked', async () => {
    render(<HomePage />)

    await waitFor(() => {
      expect(screen.getByText('home.actions.courses.title')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('home.actions.courses.title'))

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/videos/courses')
    })
  })

  it('should load videos and courses on mount', async () => {
    render(<HomePage />)

    await waitFor(() => {
      expect(listVideos).toHaveBeenCalled()
      expect(listCourses).toHaveBeenCalled()
      expect(mockUseVideoStatusCounts).toHaveBeenCalledWith(true)
    })
  })

})

describe('HomePage - getting started guide', () => {
  const emptyStats = { total: 0, completed: 0, pending: 0, processing: 0, indexing: 0, error: 0, uploading: 0 }

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    mockNavigate = useI18nNavigate() as ReturnType<typeof vi.fn>
    getAccount.mockResolvedValue({ id: 'u1', username: 'newcomer', used_ai_answers: 0 })
    listVideos.mockResolvedValue({ data: [], meta: { total: 0, limit: 5, offset: 0 } })
    listCourses.mockResolvedValue({ data: [], meta: { total: 0, limit: 1, offset: 0 } })
    mockUseVideoStatusCounts.mockReturnValue({ stats: emptyStats, isLoading: false, error: null })
  })

  it('points a new user at registering a video and hides the empty overview', async () => {
    render(<HomePage />)

    const guide = await screen.findByRole('region', { name: 'home.gettingStarted.title' })
    const current = within(guide).getAllByRole('listitem').find((item) => item.getAttribute('aria-current') === 'step')
    expect(current).toHaveTextContent('home.gettingStarted.steps.upload.title')
    expect(screen.queryByText('home.stats.summaryTitle')).not.toBeInTheDocument()

    fireEvent.click(within(guide).getByRole('button', { name: 'home.gettingStarted.steps.upload.action' }))
    expect(mockNavigate).toHaveBeenCalledWith('/videos?upload=true')
  })

  it('shows transcription as in progress while the first video is processing', async () => {
    listVideos.mockResolvedValue({ data: [mockVideos[2]], meta: { total: 1, limit: 5, offset: 0 } })
    mockUseVideoStatusCounts.mockReturnValue({ stats: { ...emptyStats, total: 1, processing: 1 }, isLoading: false, error: null })
    render(<HomePage />)

    const guide = await screen.findByRole('region', { name: 'home.gettingStarted.title' })
    expect(within(guide).getByRole('status')).toHaveTextContent('home.gettingStarted.processing')
    expect(within(guide).queryByRole('button', { name: 'home.gettingStarted.steps.upload.action' })).not.toBeInTheDocument()
  })

  it('asks for a course once a video is ready, because questions are asked in a course', async () => {
    listVideos.mockResolvedValue({ data: [mockVideos[0]], meta: { total: 1, limit: 5, offset: 0 } })
    mockUseVideoStatusCounts.mockReturnValue({ stats: { ...emptyStats, total: 1, completed: 1 }, isLoading: false, error: null })
    render(<HomePage />)

    const guide = await screen.findByRole('region', { name: 'home.gettingStarted.title' })
    expect(within(guide).getByRole('link', { name: 'home.gettingStarted.steps.course.action' })).toHaveAttribute('href', '/videos/courses')
    expect(within(guide).queryByRole('link', { name: 'home.gettingStarted.steps.ask.action' })).not.toBeInTheDocument()
  })

  it('does not count a course the user only joined', async () => {
    listVideos.mockResolvedValue({ data: [mockVideos[0]], meta: { total: 1, limit: 5, offset: 0 } })
    listCourses.mockResolvedValue({ data: [{ ...mockCourses[0], access_role: 'member' }], meta: { total: 1, limit: 1, offset: 0 } })
    mockUseVideoStatusCounts.mockReturnValue({ stats: { ...emptyStats, total: 1, completed: 1 }, isLoading: false, error: null })
    render(<HomePage />)

    const guide = await screen.findByRole('region', { name: 'home.gettingStarted.title' })
    expect(within(guide).getByRole('link', { name: 'home.gettingStarted.steps.course.action' })).toHaveAttribute('href', '/videos/courses')
    expect(chatHistory).not.toHaveBeenCalled()
  })

  it('sends the user to an empty course to add videos', async () => {
    listVideos.mockResolvedValue({ data: [mockVideos[0]], meta: { total: 1, limit: 5, offset: 0 } })
    listCourses.mockResolvedValue({ data: [{ ...mockCourses[1], video_count: 0 }], meta: { total: 1, limit: 1, offset: 0 } })
    mockUseVideoStatusCounts.mockReturnValue({ stats: { ...emptyStats, total: 1, completed: 1 }, isLoading: false, error: null })
    render(<HomePage />)

    const guide = await screen.findByRole('region', { name: 'home.gettingStarted.title' })
    expect(within(guide).getByRole('link', { name: 'home.gettingStarted.steps.course.addVideosAction' })).toHaveAttribute('href', '/videos/courses/2')
  })

  it('links the ask step to the user\'s course until a question is asked there', async () => {
    listVideos.mockResolvedValue({ data: [mockVideos[0]], meta: { total: 1, limit: 5, offset: 0 } })
    listCourses.mockResolvedValue({ data: [mockCourses[1]], meta: { total: 1, limit: 1, offset: 0 } })
    chatHistory.mockResolvedValue({ data: [], meta: { total: 0, limit: 1, offset: 0 } })
    mockUseVideoStatusCounts.mockReturnValue({ stats: { ...emptyStats, total: 1, completed: 1 }, isLoading: false, error: null })
    render(<HomePage />)

    const guide = await screen.findByRole('region', { name: 'home.gettingStarted.title' })
    expect(within(guide).getByRole('link', { name: 'home.gettingStarted.steps.ask.action' })).toHaveAttribute('href', '/videos/courses/2')
    expect(chatHistory).toHaveBeenCalledWith(expect.objectContaining({ courseId: 2, limit: 1 }))
  })

  it('stays hidden after the user dismisses it', async () => {
    const view = render(<HomePage />)

    const guide = await screen.findByRole('region', { name: 'home.gettingStarted.title' })
    fireEvent.click(within(guide).getByRole('button', { name: 'home.gettingStarted.dismiss' }))
    expect(screen.queryByRole('region', { name: 'home.gettingStarted.title' })).not.toBeInTheDocument()

    view.unmount()
    render(<HomePage />)
    await screen.findByText('home.welcome.greeting {"username":"newcomer"}')
    expect(screen.queryByRole('region', { name: 'home.gettingStarted.title' })).not.toBeInTheDocument()
  })
})

describe('HomePage - Data Loading', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAccount.mockResolvedValue({ id: 1, username: 'testuser' })
    listVideos.mockResolvedValue({
      data: mockVideos,
      meta: { total: mockVideos.length, limit: 24, offset: 0 },
    })
    listCourses.mockResolvedValue({
      data: mockCourses,
      meta: { total: mockCourses.length, limit: 1, offset: 0 },
    })
    mockUseVideoStatusCounts.mockReturnValue({
      stats: {
        total: 5,
        completed: 1,
        pending: 1,
        processing: 1,
        indexing: 1,
        error: 1,
        uploading: 0,
      },
      isLoading: false,
      error: null,
    })
  })

  it('shows the dashboard when the pending session resolves to a signed-in user', async () => {
    globalThis.__setMockAuthSession(null, true)
    const view = render(<HomePage />)
    expect(screen.getByRole('heading', { level: 1, name: /landing\.title.*landing\.titleAccent/ })).toBeInTheDocument()
    expect(screen.queryByText('common.messages.loading')).not.toBeInTheDocument()

    globalThis.__setMockAuthSession({ user: { id: '1', name: 'testuser' } })
    view.rerender(<HomePage />)
    await screen.findByText('home.welcome.greeting {"username":"testuser"}')
    expect(screen.queryByText('landing.title')).not.toBeInTheDocument()
  })

  it('keeps actions, usage and loaded videos available while courses are pending', async () => {
    listCourses.mockImplementation(() => new Promise(() => {}))
    render(<HomePage />)
    await screen.findByText('Video 1')
    expect(screen.getByText('home.usage.title')).toBeInTheDocument()
    expect(screen.getByText('home.stats.totalVideos').parentElement).toHaveTextContent('5')
    expect(within(screen.getByText('home.stats.courses').parentElement!).getByRole('progressbar')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'home.gettingStarted.title' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('home.actions.library.title'))
    expect(useI18nNavigate()).toHaveBeenCalledWith('/videos')
  })

  it('keeps the dashboard available while recent videos are pending', async () => {
    listVideos.mockImplementation(() => new Promise(() => {}))
    render(<HomePage />)
    await screen.findByText('home.usage.title')
    await waitFor(() => expect(screen.getByText('home.stats.courses').parentElement).toHaveTextContent('2'))
    expect(screen.getByText('home.recentVideos.title')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
    expect(screen.getByText('home.actions.upload.descriptionLong')).toBeInTheDocument()
  })

  it('should handle API errors gracefully', async () => {
    listVideos.mockRejectedValue(new Error('Network error'))
    listCourses.mockRejectedValue(new Error('Network error'))
    mockUseVideoStatusCounts.mockReturnValue({
      stats: {
        total: 0,
        completed: 0,
        pending: 0,
        processing: 0,
        indexing: 0,
        error: 0,
        uploading: 0,
      },
      isLoading: false,
      error: new Error('Network error'),
    })

    render(<HomePage />)

    // Should still render the page (useHomePageData catches errors internally)
    await waitFor(() => {
      expect(screen.getByText('home.welcome.greeting {"username":"testuser"}')).toBeInTheDocument()
    })
  })
})

describe('HomePage - unauthenticated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as any).__setMockAuthSession?.(null)
    getAccount.mockResolvedValue(null)
  })

  afterEach(() => {
    globalThis.__setMockLanguage('en')
  })

  it('should render the product landing page when user is not authenticated', async () => {
    render(<HomePage />)

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: /landing\.title.*landing\.titleAccent/ })).toBeInTheDocument()
    })
  })

  it('should not render home dashboard when user is not authenticated', async () => {
    render(<HomePage />)

    await waitFor(() => {
      expect(screen.queryByText(/home\.welcome\.greeting/)).not.toBeInTheDocument()
    })
  })

  it('should render signup and login actions when user is not authenticated', async () => {
    render(<HomePage />)

    await waitFor(() => {
      expect(screen.getAllByText('landing.start').length).toBeGreaterThan(0)
      expect(screen.getAllByText('landing.login').length).toBeGreaterThan(0)
    })
  })
})
