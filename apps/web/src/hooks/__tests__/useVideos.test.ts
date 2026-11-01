import { renderHook, act, waitFor } from '@testing-library/react'
import { useVideos, useVideo } from '../useVideos'
import { useVideoCourseDetailQuery } from '../useVideoCourseDetailData'

const listVideos = vi.fn()
const getVideo = vi.fn()
const getAccount = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  getAccount.mockResolvedValue({ id: 1, username: 'testuser' })
  listVideos.mockResolvedValue(mockPaginatedResponse([]))
  globalThis.__setTrpcHandler('account.me', getAccount)
  globalThis.__setTrpcHandler('videos.list', listVideos)
  globalThis.__setTrpcHandler('videos.get', getVideo)
})

const mockPaginatedResponse = (
  data: any[],
  total?: number,
  offset = 0,
) => ({
  data,
  meta: {
    total: total ?? data.length,
    limit: 24,
    offset,
  },
})

describe.each(['list', 'detail', 'course'] as const)('visual preparation polling in %s', surface => {
  beforeEach(() => {
    globalThis.__setMockPathname('/videos/1')
    window.history.pushState({}, '', '/videos/1')
  })
  afterEach(() => {
    vi.useRealTimers()
    listVideos.mockReset()
    getVideo.mockReset()
  })
  it.each(['processing', 'error'] as const)('keeps checking %s visuals after transcription completes, then stops at ready', async status => {
    vi.useFakeTimers()
    const pending = { id: 1, title: 'Video', status: 'completed', visual_processing: { status, completed_chunks: 24, total_chunks: 155 } }
    const ready = { ...pending, visual_processing: { status: 'ready', completed_chunks: 155, total_chunks: 155 } }
    listVideos.mockResolvedValueOnce(mockPaginatedResponse([pending])).mockResolvedValue(mockPaginatedResponse([ready]))
    getVideo.mockResolvedValueOnce(pending).mockResolvedValue(ready)
    const getCourse = vi.fn().mockResolvedValueOnce({ id: 1, videos: [pending] }).mockResolvedValue({ id: 1, videos: [ready] })
    globalThis.__setTrpcHandler('courses.get', getCourse)
    function useSubject() {
      useVideos({ enabled: surface === 'list' })
      useVideo(surface === 'detail' ? 1 : null)
      useVideoCourseDetailQuery(surface === 'course' ? 1 : null)
    }
    renderHook(useSubject)
    const request = surface === 'list' ? listVideos : surface === 'course' ? getCourse : getVideo
    await act(async () => { await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1)) })
    await act(async () => { await vi.advanceTimersByTimeAsync(status === 'error' ? 30_000 : 3000) })
    await act(async () => { await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2)) })
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(request).toHaveBeenCalledTimes(2)
  })
})

describe('useVideos', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should initialize with empty videos and loading state', () => {
    listVideos.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useVideos())

    expect(result.current.videos).toEqual([])
    expect(result.current.isLoading).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('should load videos from first page', async () => {
    const mockVideos = [
      { id: 1, title: 'Video 1', user: 1, file: '', uploaded_at: '', status: 'completed' as const },
      { id: 2, title: 'Video 2', user: 1, file: '', uploaded_at: '', status: 'completed' as const },
    ]
    listVideos.mockResolvedValue(mockPaginatedResponse(mockVideos))

    const { result } = renderHook(() => useVideos())

    await waitFor(() => {
      expect(result.current.videos).toEqual(mockVideos)
      expect(result.current.isLoading).toBe(false)
    })
  })

  it('shares an in-flight page request when load more is triggered twice', async () => {
    const videos = Array.from({ length: 25 }, (_, index) => ({ id: index + 1, title: `Video ${index + 1}`, status: 'completed' }))
    let finishPage!: (page: ReturnType<typeof mockPaginatedResponse>) => void
    listVideos.mockResolvedValueOnce(mockPaginatedResponse(videos.slice(0, 24), 25))
      .mockImplementationOnce(() => new Promise(resolve => { finishPage = resolve }))
    const { result } = renderHook(useVideos)
    await waitFor(() => expect(result.current.videos).toHaveLength(24))

    act(() => {
      void result.current.fetchNextPage()
      void result.current.fetchNextPage()
    })
    await waitFor(() => expect(finishPage).toBeDefined())
    try {
      expect(listVideos).toHaveBeenCalledTimes(2)
      expect(result.current.isFetchingNextPage).toBe(true)
    } finally {
      await act(async () => finishPage(mockPaginatedResponse(videos.slice(24), 25, 24)))
    }
    await waitFor(() => expect(result.current.videos).toEqual(videos))
  })

  it('should set hasNextPage to true when next is not null', async () => {
    const mockVideos = Array.from({ length: 24 }, (_, i) => ({
      id: i + 1,
      title: `Video ${i + 1}`,
      user: 1,
      file: '',
      uploaded_at: '',
      status: 'completed' as const,
    }))
    listVideos.mockResolvedValue(
      mockPaginatedResponse(mockVideos, 25, 0),
    )

    const { result } = renderHook(() => useVideos())

    await waitFor(() => {
      expect(result.current.hasNextPage).toBe(true)
    })
  })

  it('should set hasNextPage to false when next is null', async () => {
    const mockVideos = [
      { id: 1, title: 'Video 1', user: 1, file: '', uploaded_at: '', status: 'completed' as const },
    ]
    listVideos.mockResolvedValue(mockPaginatedResponse(mockVideos, 1))

    const { result } = renderHook(() => useVideos())

    await waitFor(() => {
      expect(result.current.hasNextPage).toBe(false)
    })
  })

  it('should expose totalCount from API response', async () => {
    const mockVideos = [
      { id: 1, title: 'Video 1', user: 1, file: '', uploaded_at: '', status: 'completed' as const },
    ]
    listVideos.mockResolvedValue(mockPaginatedResponse(mockVideos, 42))

    const { result } = renderHook(() => useVideos())

    await waitFor(() => {
      expect(result.current.totalCount).toBe(42)
    })
  })

  it('should pass tags param to API', async () => {
    listVideos.mockResolvedValue(mockPaginatedResponse([]))

    renderHook(() => useVideos({ tagIds: [1, 2] }))

    await waitFor(() => {
      expect(listVideos).toHaveBeenCalledWith(
        expect.objectContaining({ tags: [1, 2] }),
      )
    })
  })

  it('should pass q param to API', async () => {
    listVideos.mockResolvedValue(mockPaginatedResponse([]))

    renderHook(() => useVideos({ q: 'test query' }))

    await waitFor(() => {
      expect(listVideos).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'test query' }),
      )
    })
  })

  it('should pass ordering param to API', async () => {
    listVideos.mockResolvedValue(mockPaginatedResponse([]))

    renderHook(() => useVideos({ ordering: 'uploaded_at_asc' }))

    await waitFor(() => {
      expect(listVideos).toHaveBeenCalledWith(
        expect.objectContaining({ ordering: 'uploaded_at_asc' }),
      )
    })
  })

  it('should pass status param to API', async () => {
    listVideos.mockResolvedValue(mockPaginatedResponse([]))

    renderHook(() => useVideos({ status: 'completed' }))

    await waitFor(() => {
      expect(listVideos).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' }),
      )
    })
  })

  it('should start the first tRPC page at cursor zero', async () => {
    listVideos.mockResolvedValue(mockPaginatedResponse([]))

    renderHook(() => useVideos())

    await waitFor(() => {
      expect(listVideos).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 24 }),
      )
      expect(listVideos.mock.calls[0]?.[0]).toHaveProperty('cursor', 0)
    })
  })

  it('stops pagination after an empty page even if the total is stale', async () => {
    listVideos.mockResolvedValue(mockPaginatedResponse([], 25, 0))
    const { result } = renderHook(() => useVideos())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.hasNextPage).toBe(false)
  })

  it('should load next page when fetchNextPage is called', async () => {
    const page1 = Array.from({ length: 24 }, (_, i) => ({
      id: i + 1,
      title: `Video ${i + 1}`,
      user: 1,
      file: '',
      uploaded_at: '',
      status: 'completed' as const,
    }))
    const page2 = [
      { id: 25, title: 'Video 25', user: 1, file: '', uploaded_at: '', status: 'completed' as const },
    ]

    listVideos
      .mockResolvedValueOnce(
        mockPaginatedResponse(page1, 25, 0),
      )
      .mockResolvedValueOnce(mockPaginatedResponse(page2, 25, 24))

    const { result } = renderHook(() => useVideos())

    await waitFor(() => expect(result.current.videos).toHaveLength(24))

    await act(async () => {
      void result.current.fetchNextPage()
    })

    await waitFor(() => {
      expect(result.current.videos).toHaveLength(25)
      expect(listVideos).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 24 }),
      )
      expect(listVideos.mock.calls[0]?.[0]).toHaveProperty('cursor', 0)
      expect(listVideos).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 24, cursor: 24 }),
      )
    })
  })

  it('should flatten videos from multiple pages', async () => {
    const page1 = Array.from({ length: 24 }, (_, i) => ({
      id: i + 1,
      title: `Video ${i + 1}`,
      user: 1,
      file: '',
      uploaded_at: '',
      status: 'completed' as const,
    }))
    const page2 = Array.from({ length: 5 }, (_, i) => ({
      id: i + 25,
      title: `Video ${i + 25}`,
      user: 1,
      file: '',
      uploaded_at: '',
      status: 'completed' as const,
    }))

    listVideos
      .mockResolvedValueOnce(
        mockPaginatedResponse(page1, 29, 0),
      )
      .mockResolvedValueOnce(mockPaginatedResponse(page2, 29, 24))

    const { result } = renderHook(() => useVideos())

    await waitFor(() => expect(result.current.videos).toHaveLength(24))

    await act(async () => {
      void result.current.fetchNextPage()
    })

    await waitFor(() => {
      expect(result.current.videos).toHaveLength(29)
      expect(result.current.videos[0].id).toBe(1)
      expect(result.current.videos[24].id).toBe(25)
    })
  })

  it('should handle loading errors', async () => {
    const error = new Error('Failed to load')
    listVideos.mockRejectedValue(error)

    const { result } = renderHook(() => useVideos())

    await waitFor(() => {
      expect(result.current.error).toBe('Failed to load')
      expect(result.current.isLoading).toBe(false)
    })
  })
})

describe('useVideos - polling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(['pending', 'processing', 'indexing', 'uploading'] as const)(
    'should automatically refetch while a video has status %s',
    async (status) => {
      vi.useFakeTimers()
      const inProgressVideo = { id: 1, title: 'Video 1', user: 1, file: '', uploaded_at: '', status }
      const completedVideo = { ...inProgressVideo, status: 'completed' as const }

      listVideos
        .mockResolvedValueOnce(mockPaginatedResponse([inProgressVideo]))
        .mockResolvedValueOnce(mockPaginatedResponse([completedVideo]))

      renderHook(() => useVideos())

      await act(async () => {
        await vi.waitFor(() => expect(listVideos).toHaveBeenCalledTimes(1))
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })

      await act(async () => {
        await vi.waitFor(() => expect(listVideos).toHaveBeenCalledTimes(2))
      })

      // status is now completed — polling should stop
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000)
      })
      expect(listVideos).toHaveBeenCalledTimes(2)
    },
  )

  it('should not poll when all videos are completed', async () => {
    vi.useFakeTimers()
    const completedVideo = { id: 1, title: 'Video 1', user: 1, file: '', uploaded_at: '', status: 'completed' as const }
    listVideos.mockResolvedValue(mockPaginatedResponse([completedVideo]))

    renderHook(() => useVideos())

    await act(async () => {
      await vi.waitFor(() => expect(listVideos).toHaveBeenCalledTimes(1))
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000)
    })
    expect(listVideos).toHaveBeenCalledTimes(1)
  })
})

describe('useVideos - sentinelRef', () => {
  let capturedCallback: IntersectionObserverCallback | undefined
  const mockObserve = vi.fn()
  const mockDisconnect = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    capturedCallback = undefined
    mockObserve.mockClear()
    mockDisconnect.mockClear()

    Object.defineProperty(window, 'IntersectionObserver', {
      writable: true,
      configurable: true,
      value: vi.fn(function (callback: IntersectionObserverCallback) {
        capturedCallback = callback
        return { observe: mockObserve, unobserve: vi.fn(), disconnect: mockDisconnect }
      }),
    })
  })

  it('should return a sentinelRef function', async () => {
    listVideos.mockResolvedValue(mockPaginatedResponse([]))
    const { result } = renderHook(() => useVideos())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(typeof result.current.sentinelRef).toBe('function')
  })

  it('should observe the sentinel element when attached', async () => {
    listVideos.mockResolvedValue(mockPaginatedResponse([]))
    const { result } = renderHook(() => useVideos())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const div = document.createElement('div')
    await act(async () => { result.current.sentinelRef(div) })

    expect(mockObserve).toHaveBeenCalledWith(div)
  })

  it('should fetch next page when sentinel enters the viewport', async () => {
    const page1 = Array.from({ length: 24 }, (_, i) => ({
      id: i + 1,
      title: `Video ${i + 1}`,
      user: 1,
      file: '',
      uploaded_at: '',
      status: 'completed' as const,
    }))
    const page2 = [{ id: 25, title: 'Video 25', user: 1, file: '', uploaded_at: '', status: 'completed' as const }]

    listVideos
      .mockResolvedValueOnce(mockPaginatedResponse(page1, 25, 0))
      .mockResolvedValueOnce(mockPaginatedResponse(page2, 25, 24))

    const { result } = renderHook(() => useVideos())
    await waitFor(() => expect(result.current.hasNextPage).toBe(true))

    const div = document.createElement('div')
    await act(async () => { result.current.sentinelRef(div) })

    act(() => {
      capturedCallback!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    })

    await waitFor(() => {
      expect(result.current.videos).toHaveLength(25)
    })
  })

  it('should not make duplicate API requests on rapid intersections while fetching', async () => {
    const page1 = Array.from({ length: 24 }, (_, i) => ({
      id: i + 1,
      title: `Video ${i + 1}`,
      user: 1,
      file: '',
      uploaded_at: '',
      status: 'completed' as const,
    }))

    let resolvePage2!: (value: any) => void
    const page2Promise = new Promise<any>(resolve => { resolvePage2 = resolve })

    listVideos
      .mockResolvedValueOnce(mockPaginatedResponse(page1, 25, 0))
      .mockReturnValueOnce(page2Promise)

    const { result } = renderHook(() => useVideos())
    await waitFor(() => expect(result.current.hasNextPage).toBe(true))

    const div = document.createElement('div')
    await act(async () => { result.current.sentinelRef(div) })

    // First intersection — starts page 2 fetch
    act(() => {
      capturedCallback!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    })

    // Wait for isFetchingNextPage to become true (effect re-runs → new observer with guard)
    await waitFor(() => expect(result.current.isFetchingNextPage).toBe(true))

    // Second intersection while still fetching — guard should prevent duplicate
    act(() => {
      capturedCallback!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    })

    // Resolve page 2
    await act(async () => {
      resolvePage2(mockPaginatedResponse(
        [{ id: 25, title: 'Video 25', user: 1, file: '', uploaded_at: '', status: 'completed' as const }],
        25,
        24,
      ))
    })

    await waitFor(() => expect(result.current.isFetchingNextPage).toBe(false))

    // initial fetch (1) + page 2 (1) = 2 total — no duplicate page 2 request
    expect(listVideos).toHaveBeenCalledTimes(2)
  })

  it('should disconnect observer when sentinel is detached', async () => {
    listVideos.mockResolvedValue(mockPaginatedResponse([]))
    const { result } = renderHook(() => useVideos())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const div = document.createElement('div')
    await act(async () => { result.current.sentinelRef(div) })
    await act(async () => { result.current.sentinelRef(null) })

    expect(mockDisconnect).toHaveBeenCalled()
  })
})

describe('useVideo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as any).__setMockPathname?.('/videos/1')
    window.history.pushState({}, '', '/videos/1')
  })

  it('should initialize with null video', () => {
    getAccount.mockReturnValue(new Promise(() => {}))
    getVideo.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useVideo(1))

    expect(result.current.video).toBeNull()
    expect(result.current.isLoading).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('should not load video if videoId is null', async () => {
    const { result } = renderHook(() => useVideo(null))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(getVideo).not.toHaveBeenCalled()
  })

  it('should load video', async () => {
    const mockUser = { id: 1, username: 'testuser' }
    const mockVideo = {
      id: 1,
      title: 'Test Video',
      user: 1,
      file: '',
      uploaded_at: '',
      status: 'completed' as const,
    }
    getAccount.mockResolvedValue(mockUser)
    getVideo.mockResolvedValue(mockVideo)

    const { result } = renderHook(() => useVideo(1))

    await waitFor(() => {
      expect(result.current.video).toEqual(mockVideo)
      expect(result.current.isLoading).toBe(false)
    })
  })

  it('does not fetch private video data without a session', () => {
    globalThis.__setMockAuthSession(null)
    const { result } = renderHook(() => useVideo(1))
    expect(result.current).toEqual({ video: null, isLoading: false, error: null })
    expect(getAccount).not.toHaveBeenCalled()
    expect(getVideo).not.toHaveBeenCalled()
  })

  it('should use the shared auth query instead of a separate isAuthenticated check', async () => {
    const mockUser = { id: 1, username: 'testuser' }
    const mockVideo = {
      id: 1,
      title: 'Test Video',
      user: 1,
      file: '',
      uploaded_at: '',
      status: 'completed' as const,
    }
    getAccount.mockResolvedValue(mockUser)
    getVideo.mockResolvedValue(mockVideo)

    renderHook(() => useVideo(1))

    await waitFor(() => {
      expect(getAccount).toHaveBeenCalled()
      expect(getVideo).toHaveBeenCalledWith({ id: 1 })
    })
  })

  it('should handle loading errors', async () => {
    getAccount.mockResolvedValue({ id: 1, username: 'testuser' })
    getVideo.mockRejectedValue(new Error('Failed to load'))

    const { result } = renderHook(() => useVideo(1))

    await waitFor(() => {
      expect(result.current.error).toBe('Failed to load')
      expect(result.current.isLoading).toBe(false)
    })
  })
})

describe('useVideo - polling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as any).__setMockPathname?.('/videos/1')
    window.history.pushState({}, '', '/videos/1')
    getAccount.mockResolvedValue({ id: 1, username: 'testuser' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(['pending', 'processing', 'indexing', 'uploading'] as const)(
    'should automatically refetch while status is %s',
    async (status) => {
      vi.useFakeTimers()
      const inProgressVideo = { id: 1, title: 'Test Video', user: 1, file: '', uploaded_at: '', status }
      const completedVideo = { ...inProgressVideo, status: 'completed' as const }

      getVideo
        .mockResolvedValueOnce(inProgressVideo)
        .mockResolvedValueOnce(completedVideo)

      renderHook(() => useVideo(1))

      await act(async () => {
        await vi.waitFor(() => expect(getVideo).toHaveBeenCalledTimes(1))
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })

      await act(async () => {
        await vi.waitFor(() => expect(getVideo).toHaveBeenCalledTimes(2))
      })

      // status is now completed — polling should stop
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000)
      })
      expect(getVideo).toHaveBeenCalledTimes(2)
    },
  )

  it('should not poll once the video is completed', async () => {
    vi.useFakeTimers()
    const completedVideo = { id: 1, title: 'Test Video', user: 1, file: '', uploaded_at: '', status: 'completed' as const }
    getVideo.mockResolvedValue(completedVideo)

    renderHook(() => useVideo(1))

    await act(async () => {
      await vi.waitFor(() => expect(getVideo).toHaveBeenCalledTimes(1))
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000)
    })
    expect(getVideo).toHaveBeenCalledTimes(1)
  })

  it('should not poll once the video errors out', async () => {
    vi.useFakeTimers()
    const erroredVideo = { id: 1, title: 'Test Video', user: 1, file: '', uploaded_at: '', status: 'error' as const }
    getVideo.mockResolvedValue(erroredVideo)

    renderHook(() => useVideo(1))

    await act(async () => {
      await vi.waitFor(() => expect(getVideo).toHaveBeenCalledTimes(1))
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000)
    })
    expect(getVideo).toHaveBeenCalledTimes(1)
  })
})
