import { act, render, renderHook, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryObserver, useQueryClient } from '@tanstack/react-query'
import VideoDetailPage from '../VideoDetailPage'
import { ApiError } from '@/lib/api'
import { trpc } from '@/lib/trpc'
import { useI18nNavigate } from '@/lib/i18n'

const videoTrpcMocks = vi.hoisted(() => ({
  update: vi.fn(),
  delete: vi.fn(),
  addTags: vi.fn(),
  removeTag: vi.fn(),
}))

const mockVideo = {
  id: 1,
  title: 'Test Video',
  description: 'Test Description',
  status: 'completed',
  file: 'test.mp4',
  source_type: 'uploaded',
  youtube_embed_url: null as string | null,
  uploaded_at: '2024-01-01T00:00:00Z',
  transcript: '1\n00:00:00,000 --> 00:00:05,000\nHello world',
  tags: [{ id: 1, name: 'Tag1', color: 'red' }],
  error_message: '',
  visual_processing: null as { status: 'processing' | 'ready' | 'error'; completed_chunks: number; total_chunks: number } | null,
}

let mockUseVideoReturn = {
  video: mockVideo as typeof mockVideo | null,
  isLoading: false,
  error: null as string | null,
}

let mockSearchParams = new URLSearchParams()

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useParams: () => ({ id: '1' }),
    useSearchParams: () => [mockSearchParams, vi.fn()],
  }
})

vi.mock('@/hooks/useVideos', () => ({
  useVideo: () => mockUseVideoReturn,
}))

vi.mock('@/hooks/useTags', () => ({
  useTags: () => ({
    tags: [{ id: 1, name: 'Tag1', color: 'red' }],
    createTag: vi.fn(),
  }),
}))

beforeEach(() => {
  mockSearchParams = new URLSearchParams()
  globalThis.__setTrpcHandler('videos.update', videoTrpcMocks.update)
  globalThis.__setTrpcHandler('videos.delete', videoTrpcMocks.delete)
  globalThis.__setTrpcHandler('memberships.addTags', videoTrpcMocks.addTags)
  globalThis.__setTrpcHandler('memberships.removeTag', videoTrpcMocks.removeTag)
})

describe('VideoDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseVideoReturn = { video: mockVideo, isLoading: false, error: null }
  })

  afterEach(() => {
    globalThis.__setMockLanguage('en')
  })

  it.each(['processing', 'ready', 'error'] as const)('keeps visual %s to a compact badge without pipeline explanations', status => {
    mockUseVideoReturn.video = { ...mockVideo, visual_processing: { status, completed_chunks: 24, total_chunks: 155 } }
    render(<VideoDetailPage />)
    expect(screen.queryByText('videos.detail.statusSection')).not.toBeInTheDocument()
    expect(screen.queryByText(/videos.detail.visual.progress/)).not.toBeInTheDocument()
    expect(screen.queryByText(`videos.detail.visual.${status}`)).not.toBeInTheDocument()
    expect(screen.getByText('Hello world')).toBeInTheDocument()
  })

  it('should render video title', () => {
    render(<VideoDetailPage />)

    expect(screen.getAllByText('Test Video').length).toBeGreaterThan(0)
  })

  it('should render video description', () => {
    render(<VideoDetailPage />)

    expect(screen.getByText('Test Description')).toBeInTheDocument()
  })

  it('should render video status', () => {
    render(<VideoDetailPage />)

    expect(screen.queryByText('videos.detail.statusSection')).not.toBeInTheDocument()
    expect(screen.getByText('common.status.completed')).toBeInTheDocument()
  })

  it('should render edit button', () => {
    render(<VideoDetailPage />)

    expect(screen.getByText('videos.detail.editButton')).toBeInTheDocument()
  })

  it('should render delete button', () => {
    render(<VideoDetailPage />)

    expect(screen.getByText('videos.detail.deleteButton')).toBeInTheDocument()
  })

  it.each([false, true])('finishes deleting the original video without redirecting after leaving=%s', async leave => {
    let finishDelete!: () => void
    videoTrpcMocks.delete.mockImplementation(() => new Promise<void>(resolve => { finishDelete = resolve }))
    const navigate = useI18nNavigate() as ReturnType<typeof vi.fn>
    const { result } = renderHook(() => useQueryClient())
    const key = trpc.videos.get.queryKey({ id: 1 })
    result.current.setQueryData(key, mockVideo)
    const { unmount } = render(<VideoDetailPage />)
    fireEvent.click(screen.getByRole('button', { name: 'videos.detail.manage' }))
    fireEvent.click(screen.getByRole('button', { name: 'videos.detail.deleteButton' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.actions.delete' }))
    await waitFor(() => expect(finishDelete).toBeDefined())
    if (leave) unmount()
    await act(async () => { finishDelete() })
    await waitFor(() => expect(result.current.getQueryData(key)).toBeUndefined())
    if (leave) expect(navigate).not.toHaveBeenCalled()
    else await waitFor(() => expect(navigate).toHaveBeenCalledWith('/videos'))
  })

  it('should not render breadcrumb text', () => {
    render(<VideoDetailPage />)

    expect(screen.queryByText('videos.detail.videosBreadcrumb')).not.toBeInTheDocument()
  })

  it('should render transcript when available', () => {
    render(<VideoDetailPage />)

    expect(screen.getByText('videos.detail.transcriptSection')).toBeInTheDocument()
    expect(screen.getByText(/Hello world/)).toBeInTheDocument()
  })

  it('should open edit modal when edit button is clicked', () => {
    render(<VideoDetailPage />)

    fireEvent.click(screen.getByRole('button', { name: 'videos.detail.manage' }))
    fireEvent.click(screen.getByText('videos.detail.editButton'))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('common.actions.save')).toBeInTheDocument()
    expect(screen.getByText('common.actions.cancel')).toBeInTheDocument()
  })

  it('should not replace info card with inline form when edit button is clicked', () => {
    render(<VideoDetailPage />)

    fireEvent.click(screen.getByRole('button', { name: 'videos.detail.manage' }))
    fireEvent.click(screen.getByText('videos.detail.editButton'))

    // Info card should still be visible (title appears in card + in modal dialog)
    expect(screen.getAllByText('Test Video').length).toBeGreaterThan(0)
    // The dialog should be open
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('should not render a fixed sub-header below the nav', () => {
    const { container } = render(<VideoDetailPage />)
    const subHeader = container.querySelector('.fixed.top-16.z-40')
    expect(subHeader).toBeNull()
  })

})

describe('VideoDetailPage - Edit modal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseVideoReturn = { video: mockVideo, isLoading: false, error: null }
  })

  it.each(['metadata', 'transcript'] as const)('uses saved video detail and refreshes only affected lists after saving %s', async field => {
    const saved = { ...mockVideo, ...(field === 'metadata' ? { title: 'Updated Video' } : { transcript: `${mockVideo.transcript} updated` }) }
    videoTrpcMocks.update.mockResolvedValue(saved)
    const { result } = renderHook(() => useQueryClient())
    const keys = [
      trpc.videos.get.queryKey({ id: mockVideo.id }),
      trpc.videos.list.queryKey({ limit: 24 }),
      trpc.courses.get.queryKey({ id: 2 }),
    ]
    const fetches = keys.map(() => vi.fn(async () => ({ cached: true })))
    const unsubscribes = keys.map((queryKey, index) => {
      result.current.setQueryData(queryKey, { cached: true })
      return new QueryObserver(result.current, {
        queryKey,
        queryFn: fetches[index],
        staleTime: Infinity,
      }).subscribe(() => {})
    })
    try {
      render(<VideoDetailPage />)
      if (field === 'metadata') {
        fireEvent.click(screen.getByRole('button', { name: 'videos.detail.manage' }))
    fireEvent.click(screen.getByText('videos.detail.editButton'))
        fireEvent.change(screen.getByDisplayValue('Test Video'), { target: { value: saved.title } })
        fireEvent.click(screen.getByText('common.actions.save'))
      } else {
        fireEvent.click(screen.getByText('videos.detail.editTranscriptButton'))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: saved.transcript } })
        fireEvent.click(screen.getByText('videos.detail.saveTranscriptButton'))
        await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
      }

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      await waitFor(() => expect(result.current.isMutating()).toBe(0))
      expect(videoTrpcMocks.update).toHaveBeenCalledTimes(1)
      expect(result.current.getQueryData(keys[0])).toEqual(saved)
      expect(fetches[0]).not.toHaveBeenCalled()
      for (const fetch of fetches.slice(1)) expect(fetch).toHaveBeenCalledTimes(field === 'metadata' ? 1 : 0)
    } finally {
      unsubscribes.forEach(unsubscribe => unsubscribe())
    }
  })

  it('should show update error in modal when save fails', async () => {
    videoTrpcMocks.update.mockRejectedValue(
      new Error('Update failed'),
    )

    render(<VideoDetailPage />)

    fireEvent.click(screen.getByRole('button', { name: 'videos.detail.manage' }))
    fireEvent.click(screen.getByText('videos.detail.editButton'))
    fireEvent.change(screen.getByDisplayValue('Test Video'), { target: { value: 'Updated Video' } })
    fireEvent.click(screen.getByText('common.actions.save'))

    await waitFor(() => {
      expect(screen.getByText('Update failed')).toBeInTheDocument()
    })
  })

  it('should close modal on cancel', async () => {
    videoTrpcMocks.update.mockRejectedValue(
      new Error('Update failed'),
    )

    render(<VideoDetailPage />)

    fireEvent.click(screen.getByRole('button', { name: 'videos.detail.manage' }))
    fireEvent.click(screen.getByText('videos.detail.editButton'))
    fireEvent.change(screen.getByDisplayValue('Test Video'), { target: { value: 'Updated Video' } })
    fireEvent.click(screen.getByText('common.actions.save'))

    await waitFor(() => {
      expect(screen.getByText('Update failed')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('common.actions.cancel'))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('should clear error when modal is reopened after cancel', async () => {
    videoTrpcMocks.update.mockRejectedValue(
      new Error('Update failed'),
    )

    render(<VideoDetailPage />)

    // Open → save → error appears
    fireEvent.click(screen.getByRole('button', { name: 'videos.detail.manage' }))
    fireEvent.click(screen.getByText('videos.detail.editButton'))
    fireEvent.change(screen.getByDisplayValue('Test Video'), { target: { value: 'Updated Video' } })
    fireEvent.click(screen.getByText('common.actions.save'))
    await waitFor(() => {
      expect(screen.getByText('Update failed')).toBeInTheDocument()
    })

    // Cancel closes modal
    fireEvent.click(screen.getByText('common.actions.cancel'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // Reopen → error should NOT be visible
    fireEvent.click(screen.getByRole('button', { name: 'videos.detail.manage' }))
    fireEvent.click(screen.getByText('videos.detail.editButton'))
    expect(screen.queryByText('Update failed')).not.toBeInTheDocument()
  })
})

describe('VideoDetailPage - Delete error', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseVideoReturn = { video: mockVideo, isLoading: false, error: null }
  })

  it('should show delete error when delete fails', async () => {
    videoTrpcMocks.delete.mockRejectedValue(
      new Error('Delete failed'),
    )

    render(<VideoDetailPage />)

    fireEvent.click(screen.getByText('videos.detail.deleteButton'))
    fireEvent.click(await screen.findByRole('button', { name: 'common.actions.delete' }))

    await waitFor(() => {
      expect(screen.getByText('Delete failed')).toBeInTheDocument()
    })
  })
})

describe('VideoDetailPage - Transcript save error', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseVideoReturn = { video: mockVideo, isLoading: false, error: null }
  })

  it('should show error message when transcript save returns API error', async () => {
    videoTrpcMocks.update.mockRejectedValue(
      new ApiError('Transcript must be in valid SRT format.', 'INVALID_SRT_FORMAT'),
    )

    render(<VideoDetailPage />)

    fireEvent.click(screen.getByText('videos.detail.editTranscriptButton'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Invalid transcript' } })
    fireEvent.click(screen.getByText('videos.detail.saveTranscriptButton'))

    await waitFor(() => {
      expect(screen.getByText('Transcript must be in valid SRT format.')).toBeInTheDocument()
    })
  })

  it('should clear error message when transcript editing is cancelled', async () => {
    videoTrpcMocks.update.mockRejectedValue(
      new ApiError('Transcript must be in valid SRT format.', 'INVALID_SRT_FORMAT'),
    )

    render(<VideoDetailPage />)

    fireEvent.click(screen.getByText('videos.detail.editTranscriptButton'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Invalid transcript' } })
    fireEvent.click(screen.getByText('videos.detail.saveTranscriptButton'))

    await waitFor(() => {
      expect(screen.getByText('Transcript must be in valid SRT format.')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('videos.detail.cancel'))

    expect(screen.queryByText('Transcript must be in valid SRT format.')).not.toBeInTheDocument()
  })

  it('should clear error message when transcript editing is restarted', async () => {
    videoTrpcMocks.update.mockRejectedValue(
      new ApiError('Transcript must be in valid SRT format.', 'INVALID_SRT_FORMAT'),
    )

    render(<VideoDetailPage />)

    fireEvent.click(screen.getByText('videos.detail.editTranscriptButton'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Invalid transcript' } })
    fireEvent.click(screen.getByText('videos.detail.saveTranscriptButton'))

    await waitFor(() => {
      expect(screen.getByText('Transcript must be in valid SRT format.')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('videos.detail.cancel'))
    fireEvent.click(screen.getByText('videos.detail.editTranscriptButton'))

    expect(screen.queryByText('Transcript must be in valid SRT format.')).not.toBeInTheDocument()
  })
})

describe('VideoDetailPage - Transcript and playback', () => {
  const transcript = [
    '1\n00:00:00,000 --> 00:00:05,000\nFirst segment',
    '2\n00:00:05,000 --> 00:00:10,000\nSecond segment',
  ].join('\n\n')

  beforeEach(() => {
    vi.clearAllMocks()
    mockUseVideoReturn = { video: { ...mockVideo, transcript }, isLoading: false, error: null }
    videoTrpcMocks.update.mockResolvedValue(mockVideo)
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  })

  afterEach(() => vi.restoreAllMocks())

  it('allows a completed transcript to be cleared and restored', async () => {
    videoTrpcMocks.update.mockImplementation(async ({ transcript: value }: { transcript: string }) => {
      const saved = { ...mockVideo, transcript: value }
      mockUseVideoReturn.video = saved
      return saved
    })
    render(<VideoDetailPage />)
    for (const value of ['', transcript]) {
      const edit = screen.getByRole('button', { name: 'videos.detail.editTranscriptButton' })
      expect(edit).toBeEnabled()
      fireEvent.click(edit)
      fireEvent.change(screen.getByRole('textbox'), { target: { value } })
      fireEvent.click(screen.getByText('videos.detail.saveTranscriptButton'))
      await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
    }
    expect(videoTrpcMocks.update.mock.calls.map(([input]) => input)).toEqual([
      { id: 1, transcript: '' }, { id: 1, transcript },
    ])
    expect(screen.getByText('First segment')).toBeInTheDocument()
  })

  it.each(['link', 'subtitle'])('preserves fractional seconds when seeking from a %s', async trigger => {
    mockUseVideoReturn.video = { ...mockVideo, transcript: '1\n00:00:05,250 --> 00:00:10,000\nFractional segment' }
    if (trigger === 'link') mockSearchParams = new URLSearchParams('t=5.25')
    const { container } = render(<VideoDetailPage />)
    const player = container.querySelector('video')!
    await act(async () => {
      if (trigger === 'link') fireEvent.loadedMetadata(player)
      else fireEvent.click(screen.getByRole('button', { name: /Fractional segment/ }))
    })
    expect(player.currentTime).toBe(5.25)
  })

  it.each(['', 't=5.25'])('restarts the same YouTube subtitle without resetting on unrelated renders (%s)', query => {
    mockSearchParams = new URLSearchParams(query)
    mockUseVideoReturn.video = {
      ...mockVideo, transcript: transcript.replace('00:00:05,000 -->', '00:00:05,250 -->'), source_type: 'youtube',
      youtube_embed_url: 'https://www.youtube.com/embed/video1',
    }
    const { container } = render(<VideoDetailPage />)
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = container.querySelector('iframe')
      fireEvent.click(screen.getByRole('button', { name: /Second segment/ }))
      const current = container.querySelector('iframe')
      expect(current).not.toBe(previous)
      expect(current).toHaveAttribute('src', 'https://www.youtube.com/embed/video1?autoplay=1&start=5')
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: attempt % 2 ? '' : 'Second' } })
      expect(container.querySelector('iframe')).toBe(current)
    }
  })

  it.each(['-1', 'Infinity', '30junk'])('ignores an invalid playback query (%s)', async value => {
    mockSearchParams = new URLSearchParams({ t: value })
    const { container } = render(<VideoDetailPage />)
    const player = container.querySelector('video')!
    await act(async () => fireEvent.loadedMetadata(player))
    expect(player.currentTime).toBe(0)
    expect(player.play).not.toHaveBeenCalled()
  })

  it('closes an unchanged transcript without updating or refetching cached data', async () => {
    const { result } = renderHook(() => useQueryClient())
    const queryKey = trpc.courses.get.queryKey({ id: 2 })
    const fetch = vi.fn(async () => ({ cached: true }))
    result.current.setQueryData(queryKey, { cached: true })
    const unsubscribe = new QueryObserver(result.current, {
      queryKey, queryFn: fetch, staleTime: Infinity,
    }).subscribe(() => {})
    try {
      render(<VideoDetailPage />)
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'First' } })
      fireEvent.click(screen.getByText('videos.detail.editTranscriptButton'))
      fireEvent.click(screen.getByText('videos.detail.saveTranscriptButton'))

      await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
      expect(screen.getByRole('searchbox')).toHaveValue('')
      expect(videoTrpcMocks.update).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })

  it('saves an edited transcript without changing its contents', async () => {
    const editedTranscript = `${transcript}\n\n3\n00:00:10,000 --> 00:00:15,000\n  Third segment  \n`
    render(<VideoDetailPage />)
    fireEvent.click(screen.getByText('videos.detail.editTranscriptButton'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: editedTranscript } })
    fireEvent.click(screen.getByText('videos.detail.saveTranscriptButton'))

    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
    expect(videoTrpcMocks.update).toHaveBeenCalledExactlyOnceWith({ id: 1, transcript: editedTranscript })
  })

  it('keeps the selected subtitle attached to the same segment when the search changes', () => {
    render(<VideoDetailPage />)
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'Second' } })
    fireEvent.click(screen.getByRole('button', { name: /Second segment/ }))
    fireEvent.change(search, { target: { value: '' } })
    expect(screen.getByRole('button', { name: /Second segment/ })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: /First segment/ })).not.toHaveAttribute('aria-current')
    fireEvent.change(search, { target: { value: 'First' } })
    expect(screen.getByRole('button', { name: /First segment/ })).not.toHaveAttribute('aria-current')
  })

  it.each(['link', 'subtitle'])('tolerates autoplay rejection when seeking from a %s', async (trigger) => {
    const onPlay = vi.fn()
    // Return a real rejected promise; mock promise tracking also handles rejections.
    HTMLMediaElement.prototype.play = () => {
      onPlay()
      return Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError'))
    }
    if (trigger === 'link') mockSearchParams = new URLSearchParams('t=30')
    const { container } = render(<VideoDetailPage />)
    const player = container.querySelector('video')!
    await act(async () => {
      if (trigger === 'link') fireEvent.loadedMetadata(player)
      else fireEvent.click(screen.getByRole('button', { name: /Second segment/ }))
    })

    expect(player.currentTime).toBe(trigger === 'link' ? 30 : 5)
    expect(player.controls).toBe(true)
    expect(onPlay).toHaveBeenCalledTimes(1)
  })
})

describe('VideoDetailPage - Loading state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseVideoReturn = { video: null, isLoading: true, error: null }
  })

  afterEach(() => {
    mockUseVideoReturn = { video: mockVideo, isLoading: false, error: null }
  })

  it('should show loading content', () => {
    render(<VideoDetailPage />)
    expect(screen.getAllByRole('progressbar', { name: 'common.messages.loading' })).toHaveLength(2)
    expect(screen.getByRole('heading', { name: 'videos.detail.transcriptSection' })).toBeInTheDocument()
    expect(screen.getByRole('searchbox')).toBeDisabled()
  })
})

describe('VideoDetailPage - Error state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseVideoReturn = { video: null, isLoading: false, error: 'Network error' }
  })

  afterEach(() => {
    mockUseVideoReturn = { video: mockVideo, isLoading: false, error: null }
  })

  it('should show the error and a link back to the library', () => {
    render(<VideoDetailPage />)
    expect(screen.getByText('Network error')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'common.actions.backToList' })).toHaveAttribute('href', '/videos')
  })
})

describe('VideoDetailPage - Not found state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUseVideoReturn = { video: null, isLoading: false, error: null }
  })

  afterEach(() => {
    mockUseVideoReturn = { video: mockVideo, isLoading: false, error: null }
  })

  it('should show the not-found message', () => {
    render(<VideoDetailPage />)
    expect(screen.getByText('common.messages.videoNotFound')).toBeInTheDocument()
  })
})

describe('VideoDetailPage - Delete', () => {
  it('should call deleteVideo when delete is confirmed', async () => {
      videoTrpcMocks.delete.mockResolvedValue({})

    render(<VideoDetailPage />)

    const deleteButton = screen.getByText('videos.detail.deleteButton')
    fireEvent.click(deleteButton)
    fireEvent.click(await screen.findByRole('button', { name: 'common.actions.delete' }))

    await waitFor(() => {
      expect(videoTrpcMocks.delete).toHaveBeenCalledWith({ id: 1 })
    })
  })
})
