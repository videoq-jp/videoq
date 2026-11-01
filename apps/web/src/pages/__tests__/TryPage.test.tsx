import { render, screen } from '@testing-library/react'
import { PUBLIC_DEMO_SHARE_SLUG } from '@videoq/trpc/public-demo'
import { startLandingVisit, trackLandingEvent } from '@/lib/landingAnalytics'
import TryPage from '../TryPage'

const getSharedCourse = vi.fn()

vi.mock('@/lib/landingAnalytics', () => ({ startLandingVisit: vi.fn(), trackLandingEvent: vi.fn() }))

vi.mock('@/components/chat/ChatPanel', () => ({
  ChatPanel: ({ shareToken, suggestedQuestions, sendSuggestedQuestions, onVideoPlay }: {
    shareToken: string
    suggestedQuestions: string[]
    sendSuggestedQuestions: boolean
    onVideoPlay: (id: number, time: string) => void
  }) => (
    <div data-testid="chat-panel" data-token={shareToken} data-send={String(sendSuggestedQuestions)}>
      {suggestedQuestions.join('|')}
      <button onClick={() => onVideoPlay(1, '00:00:10')}>Play citation</button>
    </div>
  ),
}))

describe('TryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    globalThis.__setTrpcHandler('courses.shared', getSharedCourse)
    getSharedCourse.mockResolvedValue({
      id: 1, name: 'Sample', description: '',
      videos: [{ id: 1, title: 'Lesson', description: '', status: 'completed', file: 'a.mp4', source_type: 'uploaded', order: 0 }],
    })
  })

  it('keeps the explanation and sample questions visible while the course loads', () => {
    getSharedCourse.mockImplementation(() => new Promise(() => {}))
    render(<TryPage />)
    expect(screen.getByRole('heading', { level: 1, name: 'tryDemo.title' })).toBeInTheDocument()
    expect(screen.getByText('tryDemo.intro')).toBeInTheDocument()
    expect(screen.getByText('tryDemo.questions.derivative')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'tryDemo.signup' })).toHaveAttribute('href', '/signup')
    expect(screen.queryByTestId('chat-panel')).not.toBeInTheDocument()
  })

  it('opens the sample course without an account and offers signup', async () => {
    render(<TryPage />)

    const chat = await screen.findByTestId('chat-panel')
    expect(getSharedCourse).toHaveBeenCalledWith(expect.objectContaining({ slug: PUBLIC_DEMO_SHARE_SLUG }))
    expect(chat).toHaveAttribute('data-token', PUBLIC_DEMO_SHARE_SLUG)
    expect(chat).toHaveAttribute('data-send', 'true')
    expect(chat).toHaveTextContent('tryDemo.questions.derivative')
    expect(screen.getByText('tryDemo.intro')).toBeInTheDocument()
    expect(screen.getByText('courseSharing.quotaAndHistory')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'tryDemo.signup' })).toHaveAttribute('href', '/signup')
    expect(startLandingVisit).toHaveBeenCalled()
  })

  it('counts citation playback as a demo event', async () => {
    render(<TryPage />)

    ;(await screen.findByRole('button', { name: 'Play citation' })).click()
    expect(trackLandingEvent).toHaveBeenCalledWith('demo_source')
  })
})
