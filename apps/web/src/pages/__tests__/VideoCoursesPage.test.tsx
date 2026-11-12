import { act, render, renderHook, screen, fireEvent, waitFor } from '@testing-library/react'
import { useQueryClient } from '@tanstack/react-query'
import { trpc } from '@/lib/trpc'
import VideoCoursesPage from '../VideoCoursesPage'
import { useI18nNavigate } from '@/lib/i18n'

let mockNavigate: ReturnType<typeof vi.fn>

const mockCourses = [
  { id: 1, name: 'Course 1', description: 'Description 1', display_order: 0, created_at: '2024-01-01', video_count: 5 },
  { id: 2, name: 'Course 2', description: '', display_order: 1, created_at: '2024-01-02', video_count: 0 },
]

type MockGroup = (typeof mockCourses)[number]

const mockPaginatedGroups = (data: MockGroup[] = mockCourses) => ({
  data,
  meta: {
    total: data.length,
    limit: 24,
    offset: 0,
  },
})

const trpcApi = vi.hoisted(() => ({
  listCourses: vi.fn(),
  createCourse: vi.fn(),
  reorderCourses: vi.fn(),
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 1, username: 'testuser' },
    isLoading: false,
  }),
}))

describe('VideoCoursesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.__setTrpcHandler('courses.list', input => trpcApi.listCourses(input))
    globalThis.__setTrpcHandler('courses.create', input => trpcApi.createCourse(input))
    globalThis.__setTrpcHandler('courses.reorder', input => trpcApi.reorderCourses(input))
    mockNavigate = useI18nNavigate() as ReturnType<typeof vi.fn>
    trpcApi.listCourses.mockResolvedValue(mockPaginatedGroups())
    trpcApi.reorderCourses.mockResolvedValue({ courseIds: [2, 1] })
  })

  afterEach(() => {
    globalThis.__setMockLanguage('en')
  })

  it('should render page title', async () => {
    render(<VideoCoursesPage />)

    await waitFor(() => {
      expect(screen.getByText('videos.courses.title')).toBeInTheDocument()
    })
  })

  it('should render create button', async () => {
    render(<VideoCoursesPage />)

    await waitFor(() => {
      expect(screen.getByText('videos.courses.create')).toBeInTheDocument()
    })
  })

  it('should load and display courses', async () => {
    render(<VideoCoursesPage />)

    await waitFor(() => {
      expect(screen.getByText('Course 1')).toBeInTheDocument()
      expect(screen.getByText('Course 2')).toBeInTheDocument()
    })
  })

  it('stacks course meta below the title so the name can use the full row width', async () => {
    render(<VideoCoursesPage />)

    const title = await screen.findByText('Course 1')
    const stack = title.closest('div.flex-col')
    expect(stack).toBeTruthy()
    expect(stack).toHaveClass('min-w-0', 'flex-1')
  })

  it('should display video count for each course', async () => {
    render(<VideoCoursesPage />)

    await waitFor(() => {
      expect(screen.getAllByText(/videos\.courses\.videoCount/).length).toBeGreaterThan(0)
    })
  })

  it('should display empty message when no courses', async () => {
    trpcApi.listCourses.mockResolvedValue(mockPaginatedGroups([]))

    render(<VideoCoursesPage />)

    await waitFor(() => {
      expect(screen.getByText('videos.courses.empty')).toBeInTheDocument()
    })
    expect(screen.getByText('videos.courses.emptyDescription')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'videos.goToLibrary' })).toHaveAttribute('href', '/videos')
  })

  it('should open create modal when create button is clicked', async () => {
    render(<VideoCoursesPage />)

    await waitFor(() => {
      expect(screen.getByText('videos.courses.create')).toBeInTheDocument()
    })

    const createButton = screen.getByText('videos.courses.create')
    fireEvent.click(createButton)

    expect(screen.getByText('videos.courses.createTitle')).toBeInTheDocument()
  })

  it('should show name and description inputs in create modal', async () => {
    render(<VideoCoursesPage />)

    await waitFor(() => {
      expect(screen.getByText('videos.courses.create')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('videos.courses.create'))

    expect(screen.getByText('videos.courses.nameLabel')).toBeInTheDocument()
    expect(screen.getByText('videos.courses.descriptionLabel')).toBeInTheDocument()
  })

  it('should call createVideoCourse on form submit', async () => {
    trpcApi.createCourse.mockResolvedValue({ id: 3 })

    render(<VideoCoursesPage />)

    await waitFor(() => {
      expect(screen.getByText('videos.courses.create')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('videos.courses.create'))

    const nameInput = screen.getByRole('textbox', { name: 'videos.courses.nameLabel' })
    expect(nameInput).toHaveAccessibleDescription('videos.courses.namePlaceholder')
    fireEvent.change(nameInput, { target: { value: 'New Course' } })

    const createSubmitButton = screen.getByText('common.actions.create')
    fireEvent.click(createSubmitButton)

    await waitFor(() => {
      expect(trpcApi.createCourse).toHaveBeenCalledWith({
        name: 'New Course',
        description: '',
      })
    })
  })

  it('should close create modal on cancel', async () => {
    render(<VideoCoursesPage />)

    await waitFor(() => {
      expect(screen.getByText('videos.courses.create')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('videos.courses.create'))
    expect(screen.getByText('videos.courses.createTitle')).toBeInTheDocument()

    fireEvent.click(screen.getByText('common.actions.cancel'))

    await waitFor(() => {
      expect(screen.queryByText('videos.courses.createTitle')).not.toBeInTheDocument()
    })
  })

  it('should show drag handles without entering reorder mode', async () => {
    render(<VideoCoursesPage />)

    await waitFor(() => {
      expect(screen.getByText('Course 1')).toBeInTheDocument()
      expect(screen.getByText('Course 2')).toBeInTheDocument()
    })

    expect(screen.queryByText('videos.courses.reorder')).not.toBeInTheDocument()
    expect(screen.getAllByLabelText('videos.courses.dragHandle')).toHaveLength(2)
  })

  it('should save reordered course order immediately', async () => {
    render(<VideoCoursesPage />)

    await waitFor(() => {
      expect(screen.getByText('Course 1')).toBeInTheDocument()
      expect(screen.getByText('Course 2')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByLabelText('videos.courses.moveDown {"name":"Course 1"}'))

    await waitFor(() => {
      expect(trpcApi.reorderCourses).toHaveBeenCalledWith({ courseIds: [2, 1] })
    })
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('uses the server order after a successful save and subsequent refresh', async () => {
    trpcApi.listCourses.mockReset()
      .mockResolvedValueOnce(mockPaginatedGroups())
      .mockResolvedValueOnce(mockPaginatedGroups([mockCourses[1], mockCourses[0]]))
      .mockResolvedValue(mockPaginatedGroups())
    const { result } = renderHook(() => useQueryClient())
    render(<VideoCoursesPage />)
    await screen.findByText('Course 1')
    const names = () => screen.getAllByRole('button', { name: /^Course [12]/ })
      .map((button) => button.firstElementChild?.textContent)
    fireEvent.click(screen.getByLabelText('videos.courses.moveDown {"name":"Course 1"}'))
    await waitFor(() => expect(trpcApi.listCourses).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByLabelText('videos.courses.moveDown {"name":"Course 2"}')).toBeEnabled())
    expect(names()).toEqual(['Course 2', 'Course 1'])
    await act(() => result.current.invalidateQueries(trpc.courses.list.pathFilter()))
    await waitFor(() => expect(names()).toEqual(['Course 1', 'Course 2']))
  })

  it('restores the displayed order after a failed save without showing a list retry', async () => {
    trpcApi.reorderCourses.mockRejectedValueOnce(new Error('Reorder failed'))
    render(<VideoCoursesPage />)
    await screen.findByText('Course 1')
    fireEvent.click(screen.getByLabelText('videos.courses.moveDown {"name":"Course 1"}'))
    expect(await screen.findByText('Reorder failed')).toBeInTheDocument()
    const names = screen.getAllByRole('button', { name: /^Course [12]/ })
      .map((button) => button.firstElementChild?.textContent)
    expect(names).toEqual(['Course 1', 'Course 2'])
    expect(screen.queryByRole('button', { name: 'videos.courses.retryLoad' })).not.toBeInTheDocument()
    expect(trpcApi.listCourses).toHaveBeenCalledTimes(1)
  })

  it('separates joined courses and never includes them in owner reordering', async () => {
    trpcApi.listCourses.mockResolvedValue(
      mockPaginatedGroups([
        { ...mockCourses[0], access_role: 'owner' },
        { ...mockCourses[1], access_role: 'owner' },
        {
          id: 3,
          name: 'Teacher Course',
          description: 'Joined class',
          display_order: 0,
          created_at: '2024-01-03',
          video_count: 2,
          access_role: 'member',
        },
      ] as never),
    )

    render(<VideoCoursesPage />)

    expect(await screen.findByText('Teacher Course')).toBeInTheDocument()
    expect(screen.getByText('videos.courses.joinedTitle')).toBeInTheDocument()
    expect(screen.getByText('videos.courses.memberBadge')).toBeInTheDocument()
    expect(screen.getAllByLabelText('videos.courses.dragHandle')).toHaveLength(2)

    fireEvent.click(screen.getByLabelText('videos.courses.moveDown {"name":"Course 1"}'))
    await waitFor(() => {
      expect(trpcApi.reorderCourses).toHaveBeenCalledWith({ courseIds: [2, 1] })
    })
  })


})

describe('VideoCoursesPage - Error Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.__setTrpcHandler('courses.list', input => trpcApi.listCourses(input))
    globalThis.__setTrpcHandler('courses.create', input => trpcApi.createCourse(input))
    globalThis.__setTrpcHandler('courses.reorder', input => trpcApi.reorderCourses(input))
  })

  it('retries an initial failure without claiming that the course list is empty', async () => {
    trpcApi.listCourses.mockRejectedValueOnce(new Error('Load failed')).mockResolvedValue(mockPaginatedGroups())

    render(<VideoCoursesPage />)

    await waitFor(() => {
      expect(screen.getByText('Load failed')).toBeInTheDocument()
    })
    expect(screen.queryByText('videos.courses.empty')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'videos.courses.retryLoad' }))
    expect(await screen.findByText('Course 1')).toBeInTheDocument()
    expect(screen.queryByText('Load failed')).not.toBeInTheDocument()
    expect(trpcApi.listCourses.mock.calls.map(([input]) => input.cursor)).toEqual([0, 0])
  })

  it('retries only the failed next page and keeps one request in flight', async () => {
    const firstPage = { ...mockPaginatedGroups(), meta: { total: 3, limit: 24, offset: 0 } }
    const lastPage = {
      data: [{ ...mockCourses[0], id: 3, name: 'Course 3' }],
      meta: { total: 3, limit: 24, offset: 2 },
    }
    let finishPage!: (page: typeof lastPage) => void
    trpcApi.listCourses.mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(new Error('Next page failed'))
      .mockImplementationOnce(() => new Promise((resolve) => { finishPage = resolve }))
    render(<VideoCoursesPage />)
    expect(await screen.findByText('Next page failed')).toBeInTheDocument()
    expect(screen.getByText('Course 1')).toBeInTheDocument()
    expect(screen.getByText('Course 2')).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: 'videos.courses.retryLoad' })
    fireEvent.click(retry)
    fireEvent.click(retry)
    await waitFor(() => expect(finishPage).toBeDefined())
    expect(retry).toBeDisabled()
    expect(retry).toHaveAttribute('aria-busy', 'true')
    expect(trpcApi.listCourses.mock.calls.map(([input]) => input.cursor)).toEqual([0, 2, 2])
    await act(async () => { finishPage(lastPage) })
    expect(await screen.findByText('Course 3')).toBeInTheDocument()
    expect(screen.getAllByText('Course 1')).toHaveLength(1)
    expect(screen.getAllByText('Course 2')).toHaveLength(1)
    expect(screen.queryByText('Next page failed')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'videos.courses.retryLoad' })).not.toBeInTheDocument()
    expect(trpcApi.listCourses).toHaveBeenCalledTimes(3)
  })

  it('refreshes loaded pages after a background failure instead of appending a page', async () => {
    const firstPage = { ...mockPaginatedGroups(), meta: { total: 3, limit: 24, offset: 0 } }
    const lastPage = {
      data: [{ ...mockCourses[0], id: 3, name: 'Course 3' }],
      meta: { total: 3, limit: 24, offset: 2 },
    }
    trpcApi.listCourses.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(lastPage)
      .mockRejectedValueOnce(new Error('Refresh failed'))
      .mockResolvedValueOnce({ ...firstPage, data: [{ ...mockCourses[0], name: 'Updated course' }, mockCourses[1]] })
      .mockResolvedValueOnce(lastPage)
    const { result } = renderHook(() => useQueryClient())
    render(<VideoCoursesPage />)
    expect(await screen.findByText('Course 3')).toBeInTheDocument()
    await act(() => result.current.invalidateQueries(trpc.courses.list.pathFilter()))
    expect(await screen.findByText('Refresh failed')).toBeInTheDocument()
    expect(screen.getByText('Course 1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'videos.courses.retryLoad' }))
    expect(await screen.findByText('Updated course')).toBeInTheDocument()
    expect(screen.getByText('Course 3')).toBeInTheDocument()
    expect(screen.queryByText('Course 1')).not.toBeInTheDocument()
    expect(screen.queryByText('Refresh failed')).not.toBeInTheDocument()
    expect(trpcApi.listCourses.mock.calls.map(([input]) => input.cursor)).toEqual([0, 2, 0, 0, 2])
  })
})
