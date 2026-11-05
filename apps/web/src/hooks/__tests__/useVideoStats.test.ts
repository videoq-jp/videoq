import { renderHook, act, waitFor } from '@testing-library/react'
import type { VideoStatusCounts } from '@videoq/trpc'

import { useVideoStatusCounts, EMPTY_VIDEO_STATUS_COUNTS } from '../useVideoStats'

describe('useVideoStatusCounts', () => {
  it('reads server-side status totals through tRPC', async () => {
    const stats: VideoStatusCounts = {
      total: 8,
      completed: 3,
      pending: 1,
      processing: 1,
      indexing: 1,
      error: 1,
      uploading: 1,
    }
    const getCounts = vi.fn(() => stats)
    globalThis.__setTrpcHandler('videos.statusCounts', getCounts)
    const { result } = renderHook(() => useVideoStatusCounts(true))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(getCounts).toHaveBeenCalledTimes(1)
    expect(result.current).toEqual({
      stats,
      isLoading: false,
      error: null,
    })
  })

  it.each(['pending', 'processing', 'indexing', 'uploading'] as const)(
    'automatically refetches while the %s count is non-zero',
    async (status) => {
      vi.useFakeTimers()
      try {
        const inProgressStats: VideoStatusCounts = { ...EMPTY_VIDEO_STATUS_COUNTS, total: 1, [status]: 1 }
        const settledStats: VideoStatusCounts = { ...EMPTY_VIDEO_STATUS_COUNTS, total: 1, completed: 1 }
        const getCounts = vi.fn()
          .mockResolvedValueOnce(inProgressStats)
          .mockResolvedValueOnce(settledStats)
        globalThis.__setTrpcHandler('videos.statusCounts', getCounts)

        renderHook(() => useVideoStatusCounts(true))

        await act(async () => {
          await vi.waitFor(() => expect(getCounts).toHaveBeenCalledTimes(1))
        })

        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000)
        })

        await act(async () => {
          await vi.waitFor(() => expect(getCounts).toHaveBeenCalledTimes(2))
        })

        // settled counts return to the slower external-change refresh cadence
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10000)
        })
        expect(getCounts).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('refreshes completed totals to reflect external deletion', async () => {
    vi.useFakeTimers()
    try {
      const settledStats: VideoStatusCounts = { ...EMPTY_VIDEO_STATUS_COUNTS, total: 1, completed: 1 }
      const getCounts = vi.fn().mockResolvedValueOnce(settledStats).mockResolvedValue(EMPTY_VIDEO_STATUS_COUNTS)
      globalThis.__setTrpcHandler('videos.statusCounts', getCounts)

      const { result } = renderHook(() => useVideoStatusCounts(true))

      await act(async () => {
        await vi.waitFor(() => expect(getCounts).toHaveBeenCalledTimes(1))
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(getCounts).toHaveBeenCalledTimes(2)
      expect(result.current.stats.total).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
