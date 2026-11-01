import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FeedbackProvider } from '../FeedbackProvider'
import { useConfirm, useToast } from '../feedback'

function ConfirmHarness({ onResult }: { onResult: (value: boolean) => void }) {
  const confirm = useConfirm()

  const handleConfirm = async () => {
    const confirmed = await confirm({
      title: 'Delete video?',
      description: 'This action cannot be undone.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'danger',
    })
    onResult(confirmed)
  };

  return (
    <button
      onClick={() => { void handleConfirm(); }}
    >
      Open confirm
    </button>
  )
}

function ToastHarness() {
  const toast = useToast()

  return (
    <button
      onClick={() => toast({ message: 'Copy failed', variant: 'error' })}
    >
      Show toast
    </button>
  )
}

describe('FeedbackProvider', () => {
  beforeEach(() => {
    globalThis.__setMockPathname('/')
  })

  afterEach(() => {
    globalThis.__setMockPathname('/')
    vi.useRealTimers()
  })

  it('renders an accessible confirm dialog and resolves true on confirm', async () => {
    const onResult = vi.fn()

    render(
      <FeedbackProvider>
        <ConfirmHarness onResult={onResult} />
      </FeedbackProvider>,
    )

    fireEvent.click(screen.getByText('Open confirm'))

    expect(await screen.findByRole('dialog', { name: 'Delete video?' })).toBeInTheDocument()
    expect(screen.getByText('This action cannot be undone.')).toBeInTheDocument()
    // Digital Agency dialog focuses the heading on open.
    expect(screen.getByRole('heading', { name: 'Delete video?' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(onResult).toHaveBeenCalledWith(true)
      expect(screen.queryByRole('dialog', { name: 'Delete video?' })).not.toBeInTheDocument()
    })
  })

  it('resolves false when the confirm dialog is cancelled', async () => {
    const onResult = vi.fn()

    render(
      <FeedbackProvider>
        <ConfirmHarness onResult={onResult} />
      </FeedbackProvider>,
    )

    fireEvent.click(screen.getByText('Open confirm'))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(onResult).toHaveBeenCalledWith(false)
    })
  })

  it('resolves false and closes pending confirm dialogs when the route changes', async () => {
    const onResult = vi.fn()
    const ui = (
      <FeedbackProvider>
        <ConfirmHarness onResult={onResult} />
      </FeedbackProvider>
    )
    const { rerender } = render(ui)

    fireEvent.click(screen.getByText('Open confirm'))

    expect(await screen.findByRole('dialog', { name: 'Delete video?' })).toBeInTheDocument()

    globalThis.__setMockPathname('/videos')
    rerender(
      <FeedbackProvider>
        <ConfirmHarness onResult={onResult} />
      </FeedbackProvider>,
    )

    await waitFor(() => {
      expect(onResult).toHaveBeenCalledWith(false)
      expect(screen.queryByRole('dialog', { name: 'Delete video?' })).not.toBeInTheDocument()
    })
  })

  it('shows and dismisses toast messages', async () => {
    render(
      <FeedbackProvider>
        <ToastHarness />
      </FeedbackProvider>,
    )

    fireEvent.click(screen.getByText('Show toast'))

    expect(await screen.findByRole('alert')).toHaveTextContent('Copy failed')

    fireEvent.click(screen.getByRole('button', { name: 'common.actions.dismissNotification' }))

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  it('cancels a pending confirmation when the provider is removed', async () => {
    const onResult = vi.fn()
    const { unmount } = render(<FeedbackProvider><ConfirmHarness onResult={onResult} /></FeedbackProvider>)
    fireEvent.click(screen.getByText('Open confirm'))
    await act(async () => unmount())
    expect(onResult).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('clears dismissed toast timers and releases remaining timers on unmount', () => {
    vi.useFakeTimers()
    const { unmount } = render(<FeedbackProvider><ToastHarness /></FeedbackProvider>)
    const initialTimers = vi.getTimerCount()
    fireEvent.click(screen.getByText('Show toast'))
    expect(vi.getTimerCount()).toBe(initialTimers + 1)
    fireEvent.click(screen.getByRole('button', { name: 'common.actions.dismissNotification' }))
    expect(vi.getTimerCount()).toBe(initialTimers)
    fireEvent.click(screen.getByText('Show toast'))
    unmount()
    expect(vi.getTimerCount()).toBe(initialTimers)
  })
})
