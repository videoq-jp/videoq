import { act, render, renderHook, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { useQueryClient } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import type { DndContextProps, DragEndEvent } from '@dnd-kit/core'
import VideoCourseDetailPage from '../VideoCourseDetailPage'
import { useI18nNavigate } from '@/lib/i18n'
import { trpc } from '@/lib/trpc'

const courseTrpcMocks = vi.hoisted(() => ({
  get: vi.fn(),
  listVideos: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  removeVideo: vi.fn(),
  reorderVideos: vi.fn(),
  participants: vi.fn(),
  leave: vi.fn(),
}))

const dragEvents = vi.hoisted(() => ({ onDragEnd: undefined as DndContextProps['onDragEnd'] }))
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>()
  return {
    ...actual,
    // Keep real sortable controls, while allowing drag completion without jsdom layout.
    DndContext: (props: DndContextProps) => {
      dragEvents.onDragEnd = props.onDragEnd
      return <actual.DndContext {...props} />
    },
  }
})

const mockCourse = {
  id: 1,
  name: 'Test Course',
  description: 'Test Description',
  share_slug: null,
  access_role: 'owner' as const,
  videos: [
    { id: 1, title: 'Video 1', description: 'Desc 1', status: 'completed', file: 'video1.mp4', source_type: 'uploaded', order: 0 },
    { id: 2, title: 'Video 2', description: 'Desc 2', status: 'processing', file: 'video2.mp4', source_type: 'uploaded', order: 1 },
  ],
}

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useParams: () => ({ id: '1' }),
  }
})

vi.mock('@/hooks/useTags', () => ({
  useTags: () => ({
    tags: [],
  }),
}))

vi.mock('@/components/chat/ChatPanel', () => ({
  ChatPanel: () => <div data-testid="chat-panel">Chat Panel</div>,
}))

vi.mock('@/components/video/TagFilterPanel', () => ({
  TagFilterPanel: () => <div data-testid="tag-filter-panel" />,
}))

vi.mock('@/components/video/TagManagementModal', () => ({
  TagManagementModal: () => null,
}))

beforeEach(() => {
  globalThis.__setTrpcHandler('courses.get', courseTrpcMocks.get)
  globalThis.__setTrpcHandler('videos.list', courseTrpcMocks.listVideos)
  globalThis.__setTrpcHandler('courses.update', courseTrpcMocks.update)
  globalThis.__setTrpcHandler('courses.delete', courseTrpcMocks.delete)
  globalThis.__setTrpcHandler('memberships.removeVideo', courseTrpcMocks.removeVideo)
  globalThis.__setTrpcHandler('memberships.reorderVideos', courseTrpcMocks.reorderVideos)
  globalThis.__setTrpcHandler('courseMemberships.participants', courseTrpcMocks.participants)
  globalThis.__setTrpcHandler('courseMemberships.leave', courseTrpcMocks.leave)
})

describe('VideoCourseDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    courseTrpcMocks.get.mockResolvedValue(mockCourse)
    courseTrpcMocks.listVideos.mockResolvedValue({ data: [], meta: { total: 0, limit: 24, offset: 0 } })
    courseTrpcMocks.participants.mockResolvedValue({ invitations: [], members: [] })
  })

  afterEach(() => {
    globalThis.__setMockLanguage('en')
  })

  it('should render course name', async () => {
    render(<VideoCourseDetailPage />)

    await waitFor(() => {
      expect(screen.getAllByText('Test Course').length).toBeGreaterThan(0)
    })
  })

  it.each(['delete', 'leave'] as const)('finishes %s after leaving the page without redirecting or retaining deleted detail', async operation => {
    let finish!: () => void
    courseTrpcMocks[operation].mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    courseTrpcMocks.get.mockResolvedValue({ ...mockCourse, access_role: operation === 'leave' ? 'member' : 'owner' })
    const navigate = useI18nNavigate() as ReturnType<typeof vi.fn>
    const { result } = renderHook(() => useQueryClient())
    const key = trpc.courses.get.queryKey({ id: 1 })
    const { unmount } = render(<VideoCourseDetailPage />)
    fireEvent.click(await screen.findByRole('button', { name: `videos.courseDetail.${operation}` }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', {
      name: operation === 'leave' ? 'videos.courseDetail.leave' : 'common.actions.delete',
    }))
    await waitFor(() => expect(finish).toBeDefined())
    unmount()
    await act(async () => { finish() })
    expect(navigate).not.toHaveBeenCalled()
    await waitFor(() => expect(result.current.getQueryData(key)).toBeUndefined())
  })

  it('should render course description in edit form', async () => {
    render(<VideoCourseDetailPage />)

    // Click edit button (icon-only, accessed via title)
    await waitFor(() => {
      expect(screen.getByTitle('videos.courseDetail.editTitle')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTitle('videos.courseDetail.editTitle'))

    // Description should be in the edit textarea
    await waitFor(() => {
      const textarea = screen.getByDisplayValue('Test Description')
      expect(textarea).toBeInTheDocument()
    })
  })

  it('should render edit button', async () => {
    render(<VideoCourseDetailPage />)

    await waitFor(() => {
      expect(screen.getByTitle('videos.courseDetail.editTitle')).toBeInTheDocument()
    })
  })

  it('should render add videos button', async () => {
    render(<VideoCourseDetailPage />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'videos.courseDetail.pickFromLibrary' })).toBeInTheDocument()
    })
  })

  it('explains the empty course list and how to pick from the library', async () => {
    courseTrpcMocks.get.mockResolvedValue({
      ...mockCourse,
      videos: [],
    })

    render(<VideoCourseDetailPage />)

    expect(await screen.findByText('videos.courseDetail.videoListEmpty')).toBeInTheDocument()
    expect(screen.getByText('videos.courseDetail.videoListEmptyHint')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'videos.courseDetail.pickFromLibrary' }).length).toBeGreaterThan(0)
  })

  it('does not tell joined members to pick from the library on an empty course', async () => {
    courseTrpcMocks.get.mockResolvedValue({
      ...mockCourse,
      access_role: 'member',
      videos: [],
    })

    render(<VideoCourseDetailPage />)

    expect(await screen.findByText('videos.courseDetail.videoListEmpty')).toBeInTheDocument()
    expect(screen.queryByText('videos.courseDetail.videoListEmptyHint')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'videos.courseDetail.pickFromLibrary' })).not.toBeInTheDocument()
  })

  it('links to the video library when no videos can be added', async () => {
    render(<VideoCourseDetailPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'videos.courseDetail.pickFromLibrary' }))

    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('videos.courseDetail.noAvailableVideos')).toBeInTheDocument()
    expect(within(dialog).getByText('videos.courseDetail.noAvailableVideosHint')).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'videos.goToLibrary' })).toHaveAttribute('href', '/videos')
  })

  it('distinguishes a failed library request from an empty library', async () => {
    courseTrpcMocks.listVideos.mockRejectedValue(new Error('Library unavailable'))
    render(<VideoCourseDetailPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'videos.courseDetail.pickFromLibrary' }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByRole('alert')).toHaveTextContent('Library unavailable')
    expect(dialog.queryByText('videos.courseDetail.noAvailableVideos')).not.toBeInTheDocument()
  })

  it('keeps selection and closing disabled until adding and course refetch finish', async () => {
    const available = { ...mockCourse.videos[0], id: 3, title: 'New video', uploaded_at: '2026-09-01T00:00:00Z' }
    courseTrpcMocks.listVideos.mockResolvedValue({ data: [available], meta: { total: 1, limit: 100, offset: 0 } })
    let resolveCourse!: (value: typeof mockCourse) => void
    const addVideos = vi.fn(() => {
      courseTrpcMocks.get.mockImplementation(() => new Promise(resolve => { resolveCourse = resolve }))
      return { message: 'Added', added_count: 1, skipped_count: 0 }
    })
    globalThis.__setTrpcHandler('memberships.addVideos', addVideos)
    render(<VideoCourseDetailPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'videos.courseDetail.pickFromLibrary' }))
    const element = await screen.findByRole('dialog')
    const dialog = within(element)
    fireEvent.click(await dialog.findByRole('checkbox'))
    fireEvent.click(dialog.getByRole('button', { name: 'videos.courseDetail.add' }))
    await waitFor(() => expect(resolveCourse).toBeDefined())
    expect(dialog.getByRole('checkbox')).toBeDisabled()
    expect(dialog.getByRole('textbox')).toBeDisabled()
    expect(dialog.getByRole('button', { name: 'common.actions.cancel' })).toBeDisabled()
    await userEvent.click(dialog.getByRole('button', { name: 'common.actions.cancel' }))
    fireEvent(element, new Event('cancel', { cancelable: true }))
    expect(element).toBeInTheDocument()
    await act(async () => resolveCourse({ ...mockCourse, videos: [...mockCourse.videos, available] }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(addVideos).toHaveBeenCalledWith({ courseId: 1, videoIds: [3] })
  })

  it('retains selection and exposes the add error before retrying', async () => {
    const available = { ...mockCourse.videos[0], id: 3, title: 'New video', uploaded_at: '2026-09-01T00:00:00Z' }
    courseTrpcMocks.listVideos.mockResolvedValue({ data: [available], meta: { total: 1, limit: 100, offset: 0 } })
    const addVideos = vi.fn().mockRejectedValueOnce(new Error('Add failed')).mockResolvedValue({ message: 'Added', added_count: 1, skipped_count: 0 })
    globalThis.__setTrpcHandler('memberships.addVideos', addVideos)
    render(<VideoCourseDetailPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'videos.courseDetail.pickFromLibrary' }))
    const element = await screen.findByRole('dialog')
    const dialog = within(element)
    fireEvent.click(await dialog.findByRole('checkbox'))
    fireEvent.click(dialog.getByRole('button', { name: 'videos.courseDetail.add' }))
    const error = await dialog.findByRole('alert')
    expect(error).toHaveTextContent('Add failed')
    await waitFor(() => expect(error.parentElement).toHaveFocus())
    expect(dialog.getByRole('checkbox')).toBeChecked()
    fireEvent.click(dialog.getByRole('button', { name: 'videos.courseDetail.add' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(addVideos).toHaveBeenCalledTimes(2)
    expect(addVideos).toHaveBeenLastCalledWith({ courseId: 1, videoIds: [3] })
  })

  it('uses a compact viewer header with the existing logo and a course-list link', async () => {
    render(<VideoCourseDetailPage />)

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'VideoQ' })).toHaveAttribute('href', '/videos/courses')
      expect(screen.getByRole('link', { name: 'VideoQ' }).querySelector('img')).toHaveAttribute('src', '/logo192.png')
      expect(screen.getAllByText('Test Course').length).toBeGreaterThan(0)
    })
  })

  it('should render delete button', async () => {
    render(<VideoCourseDetailPage />)

    await waitFor(() => {
      expect(screen.getByTitle('videos.courseDetail.delete')).toBeInTheDocument()
    })
  })

  it('should render video list', async () => {
    render(<VideoCourseDetailPage />)

    await waitFor(() => {
      expect(screen.getAllByText('Video 1').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Video 2').length).toBeGreaterThan(0)
    })
  })

  it('marks only the video being removed as busy and blocks every remove button meanwhile', async () => {
    let resolveRemove: () => void = () => {}
    courseTrpcMocks.removeVideo.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveRemove = () => resolve()
      })
    )

    render(<VideoCourseDetailPage />)

    const removeButtons = await screen.findAllByRole('button', { name: 'videos.courseDetail.removeFromCourse' })
    expect(removeButtons[0]).not.toBeDisabled()
    fireEvent.click(removeButtons[0])

    const dialog = await screen.findByRole('dialog', { name: /videos\.courseDetail\.removeVideoConfirm/ })
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.actions.confirm' }))

    await waitFor(() => {
      expect(courseTrpcMocks.removeVideo).toHaveBeenCalledWith({ courseId: 1, videoId: 1 })
    })

    const pending = screen.getAllByRole('button', { name: 'videos.courseDetail.removeFromCourse' })
    expect(pending[0]).toBeDisabled()
    expect(pending[0]).toHaveAttribute('aria-busy', 'true')
    // The other row must not claim to be busy, but it must not accept a second
    // removal while one is already in flight either.
    expect(pending[1]).toBeDisabled()
    expect(pending[1]).not.toHaveAttribute('aria-busy', 'true')

    resolveRemove()

    await waitFor(() => {
      const settled = screen.getAllByRole('button', { name: 'videos.courseDetail.removeFromCourse' })
      expect(settled[0]).not.toBeDisabled()
      expect(settled[0]).not.toHaveAttribute('aria-busy', 'true')
    })
  })

  it('blocks reordering, editing, adding and deleting the course while a video removal is in flight', async () => {
    let resolveRemove: () => void = () => {}
    courseTrpcMocks.removeVideo.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveRemove = () => resolve()
      })
    )

    const { container } = render(<VideoCourseDetailPage />)

    const removeButtons = await screen.findAllByRole('button', { name: 'videos.courseDetail.removeFromCourse' })
    const handles = () => Array.from(container.querySelectorAll('[aria-roledescription="sortable"]'))
    expect(handles()).toHaveLength(2)
    for (const handle of handles()) {
      expect(handle).toHaveAttribute('aria-disabled', 'false')
    }

    fireEvent.click(removeButtons[0])
    const dialog = await screen.findByRole('dialog', { name: /videos\.courseDetail\.removeVideoConfirm/ })
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.actions.confirm' }))

    // A reorder sent mid-removal would include the video being deleted, which
    // the server rejects with a 400 and the UI surfaces as an order-update error.
    await waitFor(() => {
      for (const handle of handles()) {
        expect(handle).toHaveAttribute('aria-disabled', 'true')
      }
    })
    const controls = [
      screen.getByRole('button', { name: 'videos.courseDetail.pickFromLibrary' }),
      screen.getByRole('button', { name: 'videos.courseDetail.editTitle' }),
      screen.getByRole('button', { name: 'videos.courseDetail.delete' }),
    ]
    for (const control of controls) expect(control).toBeDisabled()

    resolveRemove()

    await waitFor(() => {
      for (const handle of handles()) {
        expect(handle).toHaveAttribute('aria-disabled', 'false')
      }
      for (const control of controls) expect(control).toBeEnabled()
    })
  })

  it('does not select a row when its disabled remove button is clicked', async () => {
    let resolveRemove: () => void = () => {}
    courseTrpcMocks.removeVideo.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveRemove = () => resolve()
      })
    )

    const { container } = render(<VideoCourseDetailPage />)

    const removeButtons = await screen.findAllByRole('button', { name: 'videos.courseDetail.removeFromCourse' })
    await waitFor(() => {
      expect(new URL(container.querySelector('video')!.src).pathname).toBe('/api/video1.mp4')
    })

    fireEvent.click(removeButtons[0])
    const dialog = await screen.findByRole('dialog', { name: /videos\.courseDetail\.removeVideoConfirm/ })
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.actions.confirm' }))

    await waitFor(() => {
      expect(courseTrpcMocks.removeVideo).toHaveBeenCalled()
    })

    // A disabled Button has `pointer-events: none`, so this click must be
    // swallowed by the wrapper instead of falling through to the row.
    fireEvent.click(screen.getAllByRole('button', { name: 'videos.courseDetail.removeFromCourse' })[1])

    expect(new URL(container.querySelector('video')!.src).pathname).toBe('/api/video1.mp4')

    await act(async () => { resolveRemove() })
    // Finish the mutation and its refetch before the next test replaces handlers.
    await waitFor(() => {
      for (const button of screen.getAllByRole('button', { name: 'videos.courseDetail.removeFromCourse' })) {
        expect(button).toBeEnabled()
      }
    })
  })

  it('blocks conflicting edits while saving video order, then re-enables them without a detail refetch', async () => {
    let finishSave!: () => void
    courseTrpcMocks.reorderVideos.mockImplementation(() => new Promise<void>((resolve) => { finishSave = resolve }))
    const { container } = render(<VideoCourseDetailPage />)
    await screen.findByRole('button', { name: 'videos.courses.dragHandle: Video 1' })
    const handles = () => Array.from(container.querySelectorAll('[aria-roledescription="sortable"]'))
    const editButtons = () => [
      ...handles(),
      ...screen.getAllByRole('button', { name: 'videos.courseDetail.removeFromCourse' }),
      screen.getByRole('button', { name: 'videos.courseDetail.pickFromLibrary' }),
      screen.getByRole('button', { name: 'videos.courseDetail.editTitle' }),
      screen.getByRole('button', { name: 'videos.courseDetail.delete' }),
    ]
    act(() => { dragEvents.onDragEnd?.({ active: { id: 1 }, over: { id: 2 } } as DragEndEvent) })
    await waitFor(() => expect(courseTrpcMocks.reorderVideos).toHaveBeenCalledExactlyOnceWith({ courseId: 1, videoIds: [2, 1] }))
    for (const button of editButtons()) expect(button).toBeDisabled()
    for (const handle of handles()) expect(handle).toHaveAttribute('aria-disabled', 'true')
    expect(handles().map((handle) => handle.getAttribute('aria-label'))).toEqual([
      'videos.courses.dragHandle: Video 2', 'videos.courses.dragHandle: Video 1',
    ])
    act(() => { dragEvents.onDragEnd?.({ active: { id: 2 }, over: { id: 1 } } as DragEndEvent) })
    expect(courseTrpcMocks.reorderVideos).toHaveBeenCalledTimes(1)
    // Watching a video is still allowed while order is being saved.
    fireEvent.click(screen.getByRole('button', { name: /Video 2/, pressed: false }))
    expect(new URL(container.querySelector('video')!.src).pathname).toBe('/api/video2.mp4')
    act(() => { finishSave() })
    await waitFor(() => { for (const button of editButtons()) expect(button).toBeEnabled() })
    expect(courseTrpcMocks.get).toHaveBeenCalledTimes(1)
  })

  it('restores the server order after a failed drag save and allows another drag', async () => {
    courseTrpcMocks.reorderVideos.mockRejectedValue(new Error('Order failed'))
    const { container } = render(<VideoCourseDetailPage />)
    await screen.findByRole('button', { name: 'videos.courses.dragHandle: Video 1' })
    act(() => { dragEvents.onDragEnd?.({ active: { id: 1 }, over: { id: 2 } } as DragEndEvent) })
    expect(await screen.findByText('Order failed')).toBeInTheDocument()
    expect(courseTrpcMocks.get).toHaveBeenCalledTimes(2)
    const handles = Array.from(container.querySelectorAll('[aria-roledescription="sortable"]'))
    expect(handles.map((handle) => handle.getAttribute('aria-label'))).toEqual([
      'videos.courses.dragHandle: Video 1', 'videos.courses.dragHandle: Video 2',
    ])
    for (const handle of handles) expect(handle).toBeEnabled()
  })

  it('reports removal failures and re-enables the remove buttons', async () => {
    courseTrpcMocks.removeVideo.mockRejectedValue(new Error('boom'))

    render(<VideoCourseDetailPage />)

    const removeButtons = await screen.findAllByRole('button', { name: 'videos.courseDetail.removeFromCourse' })
    fireEvent.click(removeButtons[0])

    const dialog = await screen.findByRole('dialog', { name: /videos\.courseDetail\.removeVideoConfirm/ })
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.actions.confirm' }))

    await waitFor(() => {
      expect(courseTrpcMocks.removeVideo).toHaveBeenCalled()
    })

    await waitFor(() => {
      for (const button of screen.getAllByRole('button', { name: 'videos.courseDetail.removeFromCourse' })) {
        expect(button).not.toBeDisabled()
      }
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('boom')
  })

  it('keeps one chat panel mounted across responsive layouts and mobile tabs', async () => {
    render(<VideoCourseDetailPage />)

    const panel = await screen.findByTestId('chat-panel')
    try {
      for (const width of [390, 1280, 390]) {
        vi.stubGlobal('innerWidth', width)
        fireEvent(window, new Event('resize'))
        expect(screen.getByTestId('chat-panel')).toBe(panel)
      }
      for (const tab of ['videos', 'overview', 'assistant']) {
        fireEvent.click(screen.getByRole('tab', { name: `videos.shared.tabs.${tab}` }))
        expect(screen.getByTestId('chat-panel')).toBe(panel)
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('should enter edit mode when edit button is clicked', async () => {
    render(<VideoCourseDetailPage />)

    await waitFor(() => {
      expect(screen.getByTitle('videos.courseDetail.editTitle')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTitle('videos.courseDetail.editTitle'))

    expect(screen.getAllByText('common.actions.save').length).toBeGreaterThan(0)
    expect(screen.getByText('common.actions.cancel')).toBeInTheDocument()
  })

  it('should show share section in dialog', async () => {
    render(<VideoCourseDetailPage />)

    await waitFor(() => {
      expect(screen.getByText('videos.courseDetail.shareOpen')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('videos.courseDetail.shareOpen'))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('videos.courseDetail.shareLinkLabel')).toBeInTheDocument()
    expect(within(dialog).getByText('common.actions.save')).toBeInTheDocument()
  })

  it('opens member management for the owner', async () => {
    render(<VideoCourseDetailPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'videos.courseMembers.open' }))

    expect(await screen.findByText('videos.courseMembers.title')).toBeInTheDocument()
    expect(courseTrpcMocks.participants).toHaveBeenCalledWith({ courseId: 1 })
  })

  it('shows read-only controls to a joined member and asks for confirmation before leaving', async () => {
    courseTrpcMocks.get.mockResolvedValue({
      ...mockCourse,
      access_role: 'member',
    })
    courseTrpcMocks.leave.mockResolvedValue(undefined)

    render(<VideoCourseDetailPage />)

    expect(await screen.findByRole('button', { name: 'videos.courseDetail.leave' })).toBeInTheDocument()
    expect(screen.queryByText('videos.courseDetail.shareOpen')).not.toBeInTheDocument()
    expect(screen.queryByTitle('videos.courseDetail.editTitle')).not.toBeInTheDocument()
    expect(screen.queryByTitle('videos.courseDetail.delete')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'videos.courseDetail.pickFromLibrary' })).not.toBeInTheDocument()
    expect(screen.queryAllByRole('button', { name: 'videos.courseDetail.removeFromCourse' })).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'videos.courseDetail.leave' }))

    const dialog = await screen.findByRole('dialog', { name: /confirmations\.leaveCourse/ })
    expect(within(dialog).getByText('confirmations.leaveCourseDescription')).toBeInTheDocument()
    expect(courseTrpcMocks.leave).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'common.actions.cancel' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /confirmations\.leaveCourse/ })).not.toBeInTheDocument()
    })
    expect(courseTrpcMocks.leave).not.toHaveBeenCalled()
  })

  it('leaves a joined course only after the member confirms', async () => {
    courseTrpcMocks.get.mockResolvedValue({
      ...mockCourse,
      access_role: 'member',
    })
    courseTrpcMocks.leave.mockResolvedValue(undefined)
    const navigate = useI18nNavigate() as ReturnType<typeof vi.fn>

    render(<VideoCourseDetailPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'videos.courseDetail.leave' }))
    const dialog = await screen.findByRole('dialog', { name: /confirmations\.leaveCourse/ })
    fireEvent.click(within(dialog).getByRole('button', { name: 'videos.courseDetail.leave' }))

    await waitFor(() => {
      expect(courseTrpcMocks.leave).toHaveBeenCalledWith({ courseId: 1 })
      expect(navigate).toHaveBeenCalledWith('/videos/courses')
    })
  })

  it('should not render a fixed sub-header below the nav', async () => {
    const { container } = render(<VideoCourseDetailPage />)
    await waitFor(() => {
      expect(screen.getAllByText('Test Course').length).toBeGreaterThan(0)
    })
    const subHeader = container.querySelector('.fixed.top-16.z-40')
    expect(subHeader).toBeNull()
  })

  it('should not autoplay youtube video on initial render', async () => {
    const youtubeCourse = {
      ...mockCourse,
      videos: [
        {
          id: 1,
          title: 'Video 1',
          description: 'Desc 1',
          status: 'completed',
          file: null,
          source_type: 'youtube' as const,
          youtube_embed_url: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
          order: 0,
        },
      ],
    }
    courseTrpcMocks.get.mockResolvedValue(youtubeCourse)

    const { container } = render(<VideoCourseDetailPage />)

    await waitFor(() => {
      const iframe = container.querySelector('iframe')
      expect(iframe).not.toBeNull()
      expect(iframe?.getAttribute('src')).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ')
    })
  })


})

describe('VideoCourseDetailPage - Metadata edits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    courseTrpcMocks.get.mockResolvedValue(mockCourse)
  })

  it.each(['name', 'description'] as const)('saves only the edited %s while following background changes to the other field', async field => {
    const other = field === 'name' ? 'description' : 'name'
    const { result } = renderHook(() => useQueryClient())
    render(<VideoCourseDetailPage />)
    fireEvent.click(await screen.findByTitle('videos.courseDetail.editTitle'))
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByDisplayValue(mockCourse[field]), { target: { value: 'My edit' } })

    const current = { ...mockCourse, [field]: 'Concurrent edit', [other]: 'Updated elsewhere' }
    act(() => { result.current.setQueryData(trpc.courses.get.queryKey({ id: 1 }), current) })
    await waitFor(() => expect(dialog.getByDisplayValue('Updated elsewhere')).toBeInTheDocument())
    expect(dialog.getByDisplayValue('My edit')).toBeInTheDocument()
    courseTrpcMocks.update.mockResolvedValue({ ...current, [field]: 'My edit' })
    fireEvent.click(dialog.getByRole('button', { name: 'common.actions.save' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(courseTrpcMocks.update).toHaveBeenCalledExactlyOnceWith({ id: 1, [field]: 'My edit' })
    expect(result.current.getQueryData(trpc.courses.get.queryKey({ id: 1 }))).toEqual({ ...current, [field]: 'My edit' })
    expect(courseTrpcMocks.get).toHaveBeenCalledTimes(1)
  })

  it('discards cancelled edits, skips unchanged saves, and allows explicitly clearing a description', async () => {
    const { result } = renderHook(() => useQueryClient())
    render(<VideoCourseDetailPage />)
    const edit = await screen.findByTitle('videos.courseDetail.editTitle')
    fireEvent.click(edit)
    let dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByDisplayValue(mockCourse.name), { target: { value: 'Cancelled edit' } })
    fireEvent.click(dialog.getByRole('button', { name: 'common.actions.cancel' }))
    const current = { ...mockCourse, name: 'Updated elsewhere' }
    act(() => { result.current.setQueryData(trpc.courses.get.queryKey({ id: 1 }), current) })
    fireEvent.click(edit)
    dialog = within(await screen.findByRole('dialog'))
    await waitFor(() => expect(dialog.getByDisplayValue(current.name)).toBeInTheDocument())
    fireEvent.click(dialog.getByRole('button', { name: 'common.actions.save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(courseTrpcMocks.update).not.toHaveBeenCalled()

    fireEvent.click(edit)
    dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByDisplayValue(current.description), { target: { value: '' } })
    courseTrpcMocks.update.mockResolvedValue({ ...current, description: '' })
    fireEvent.click(dialog.getByRole('button', { name: 'common.actions.save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(courseTrpcMocks.update).toHaveBeenCalledExactlyOnceWith({ id: 1, description: '' })
    expect(courseTrpcMocks.get).toHaveBeenCalledTimes(1)
  })
})

describe('VideoCourseDetailPage - Edit modal error', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    courseTrpcMocks.get.mockResolvedValue(mockCourse)
    courseTrpcMocks.update.mockRejectedValue(
      new Error('Update failed'),
    )
  })

  it('should clear update error when modal is reopened after cancel', async () => {
    render(<VideoCourseDetailPage />)

    // Open edit modal
    await waitFor(() => {
      expect(screen.getByTitle('videos.courseDetail.editTitle')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTitle('videos.courseDetail.editTitle'))

    const dialog = await screen.findByRole('dialog')

    // Change the name and save → error appears.
    fireEvent.change(within(dialog).getByDisplayValue('Test Course'), { target: { value: 'Updated Course' } })
    fireEvent.click(within(dialog).getByText('common.actions.save'))
    await waitFor(() => {
      expect(within(dialog).getByText('Update failed')).toBeInTheDocument()
    })

    // Cancel closes modal
    fireEvent.click(within(dialog).getByText('common.actions.cancel'))

    // Reopen → error should NOT be visible
    fireEvent.click(screen.getByTitle('videos.courseDetail.editTitle'))
    const dialog2 = await screen.findByRole('dialog')
    expect(within(dialog2).queryByText('Update failed')).not.toBeInTheDocument()
  })
})

describe('VideoCourseDetailPage - Share Link', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const courseWithShare = { ...mockCourse, share_slug: 'test-token-123' }
    courseTrpcMocks.get.mockResolvedValue(courseWithShare)
  })

  it('should show share link when token exists', async () => {
    render(<VideoCourseDetailPage />)

    await waitFor(() => {
      expect(screen.getByText('videos.courseDetail.shareOpen')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('videos.courseDetail.shareOpen'))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('videos.courseDetail.copyButton')).toBeInTheDocument()
    expect(within(dialog).getByText('videos.courseDetail.disable')).toBeInTheDocument()
  })
})

describe('VideoCourseDetailPage - Loading state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Never-resolving promise simulates initial loading
    courseTrpcMocks.get.mockImplementation(() => new Promise(() => {}))
  })

  it('should show loading content', async () => {
    render(<VideoCourseDetailPage />)
    expect(screen.getByText('common.messages.loading')).toBeInTheDocument()
  })
})

describe('VideoCourseDetailPage - Delete', () => {
  let currentGroup = structuredClone(mockCourse)

  beforeEach(() => {
    vi.clearAllMocks()
    currentGroup = structuredClone(mockCourse)
    courseTrpcMocks.get.mockImplementation(() => Promise.resolve(structuredClone(currentGroup)))
    courseTrpcMocks.delete.mockResolvedValue({})
    courseTrpcMocks.removeVideo.mockImplementation(async (input: { videoId: number }) => {
        currentGroup = {
          ...currentGroup,
          videos: currentGroup.videos.filter((video) => video.id !== input.videoId),
        }
      })
  })

  it('deletes the confirmed course while blocking competing edits until it finishes', async () => {
    let finishDelete!: () => void
    courseTrpcMocks.delete.mockImplementation(() => new Promise<void>((resolve) => { finishDelete = resolve }))
    render(<VideoCourseDetailPage />)

    await waitFor(() => {
      expect(screen.getByTitle('videos.courseDetail.delete')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTitle('videos.courseDetail.delete'))
    fireEvent.click(await screen.findByRole('button', { name: 'common.actions.delete' }))

    await waitFor(() => {
      expect(courseTrpcMocks.delete).toHaveBeenCalledWith({ id: 1 })
    })
    const controls = [
      screen.getByRole('button', { name: 'videos.courseDetail.pickFromLibrary' }),
      screen.getByRole('button', { name: 'videos.courseDetail.editTitle' }),
      screen.getByRole('button', { name: 'videos.courseDetail.delete' }),
      ...screen.getAllByRole('button', { name: 'videos.courseDetail.removeFromCourse' }),
      screen.getByRole('button', { name: 'videos.courses.dragHandle: Video 1' }),
      screen.getByRole('button', { name: 'videos.courses.dragHandle: Video 2' }),
    ]
    for (const control of controls) expect(control).toBeDisabled()
    act(() => { dragEvents.onDragEnd?.({ active: { id: 1 }, over: { id: 2 } } as DragEndEvent) })
    expect(courseTrpcMocks.reorderVideos).not.toHaveBeenCalled()
    act(() => { finishDelete() })
    await waitFor(() => expect(useI18nNavigate()).toHaveBeenCalledWith('/videos/courses'))
  })

  it('should show a visible remove-from-course action for each video without hover-only classes', async () => {
    render(<VideoCourseDetailPage />)

    const removeButtons = await screen.findAllByRole('button', { name: 'videos.courseDetail.removeFromCourse' })

    expect(removeButtons).toHaveLength(2)
    removeButtons.forEach((button) => {
      expect(button).not.toHaveClass('opacity-0')
      expect(button).not.toHaveClass('group-hover:opacity-100')
      expect(button).toHaveTextContent('')
    })
  })

  it('should show delete error when delete fails', async () => {
    courseTrpcMocks.delete.mockRejectedValue(
      new Error('Delete failed'),
    )

    render(<VideoCourseDetailPage />)

    await waitFor(() => {
      expect(screen.getByTitle('videos.courseDetail.delete')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTitle('videos.courseDetail.delete'))
    fireEvent.click(await screen.findByRole('button', { name: 'common.actions.delete' }))

    await waitFor(() => {
      expect(screen.getByText('Delete failed')).toBeInTheDocument()
    })
  })

  it('should remove the video from the course list when removal is confirmed', async () => {
    render(<VideoCourseDetailPage />)

    const [firstRemoveButton] = await screen.findAllByRole('button', { name: 'videos.courseDetail.removeFromCourse' })
    fireEvent.click(firstRemoveButton)
    fireEvent.click(await screen.findByRole('button', { name: 'common.actions.confirm' }))

    await waitFor(() => {
      expect(courseTrpcMocks.removeVideo).toHaveBeenCalledWith({ courseId: 1, videoId: 1 })
    })

    await waitFor(() => {
      expect(screen.queryAllByText('Video 1')).toHaveLength(0)
      expect(screen.getAllByText('Video 2').length).toBeGreaterThan(0)
    })
  })

  it('should reset autoVideoId when the auto-selected video is removed from the course', async () => {
    // After Video 1 (initially auto-selected) is removed, autoVideoId should
    // update to Video 2. Subsequent title queries confirm Video 2 is now tracked.
    render(<VideoCourseDetailPage />)

    // Wait for initial render with Video 1 auto-selected
    await screen.findAllByRole('button', { name: 'videos.courseDetail.removeFromCourse' })

    // Remove Video 1 (the auto-selected one)
    const [firstRemoveButton] = screen.getAllByRole('button', { name: 'videos.courseDetail.removeFromCourse' })
    fireEvent.click(firstRemoveButton)
    fireEvent.click(await screen.findByRole('button', { name: 'common.actions.confirm' }))

    await waitFor(() => {
      expect(screen.queryAllByText('Video 1')).toHaveLength(0)
    })

    // Video 2 should now be shown in the list (and become the new auto-selected)
    expect(screen.getAllByText('Video 2').length).toBeGreaterThan(0)
  })

  it('should keep player on Video 2 after deleting Video 1 (auto-selected) and then receiving a reordered list [Video 3, Video 2]', async () => {
    // Regression: after deletion shifts autoVideoId to V2, a subsequent reorder
    // that puts V3 first must NOT override autoVideoId with V3.

    // Override to 3-video course for this test
    const video3 = { id: 3, title: 'Video 3', description: 'Desc 3', status: 'completed', file: 'video3.mp4', source_type: 'uploaded', order: 2 }
    currentGroup = { ...mockCourse, videos: [...mockCourse.videos, video3] }
    courseTrpcMocks.update.mockImplementation(async (patch) => {
      currentGroup = { ...currentGroup, ...patch }
      return currentGroup
    })

    const { container } = render(<VideoCourseDetailPage />)

    // Wait for all 3 remove buttons (initial load with V1, V2, V3)
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'videos.courseDetail.removeFromCourse' })).toHaveLength(3)
    })

    // Step 1: Delete Video 1 (auto-selected)
    // removeVideoFromCourse mock mutates currentGroup → [V2, V3]
    // Removal invalidates the detail; refetch returns [V2, V3]
    // autoVideoId: V1 stale → resets to V2 (first in new list)
    const [firstRemoveButton] = screen.getAllByRole('button', { name: 'videos.courseDetail.removeFromCourse' })
    fireEvent.click(firstRemoveButton)
    fireEvent.click(await screen.findByRole('button', { name: 'common.actions.confirm' }))

    await waitFor(() => {
      expect(screen.queryAllByText('Video 1')).toHaveLength(0)
    })

    // Step 2: Simulate an external reorder — V3 moves before V2
    // The next save response includes the server's current order [V3, V2].
    currentGroup = {
      ...currentGroup,
      videos: [
        { id: 3, title: 'Video 3', description: 'Desc 3', status: 'completed', file: 'video3.mp4', source_type: 'uploaded', order: 0 },
        { id: 2, title: 'Video 2', description: 'Desc 2', status: 'processing', file: 'video2.mp4', source_type: 'uploaded', order: 1 },
      ],
    }

    // Apply the returned course by saving a metadata change.
    fireEvent.click(screen.getByTitle('videos.courseDetail.editTitle'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByDisplayValue('Test Course'), { target: { value: 'Updated Course' } })
    fireEvent.click(within(dialog).getByText('common.actions.save'))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(courseTrpcMocks.update).toHaveBeenCalledWith({ id: 1, name: 'Updated Course' })
    expect(courseTrpcMocks.get).toHaveBeenCalledTimes(2)

    // After re-render with [V3, V2]:
    //   autoVideoId is still V2 (V2 is in the list → no reset)
    //   selectedVideo → V2 (from autoVideoId)
    //   Player must show video2.mp4, NOT video3.mp4
    await waitFor(() => {
      const videoEl = container.querySelector('video')
      expect(new URL(videoEl!.src).pathname).toBe('/api/video2.mp4')
    })
  })
})
