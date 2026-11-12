import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { apiClient } from '@/lib/api'
import { useQueryClient } from '@tanstack/react-query'
import { useI18nNavigate } from '@/lib/i18n'
import * as landingAnalytics from '@/lib/landingAnalytics'

// Unmock AppNav so we can test the real implementation
vi.unmock('@/components/layout/AppNav')

const { AppNav } = await vi.importActual<typeof import('../AppNav')>('../AppNav')
const getAccount = vi.fn()

beforeEach(() => {
  getAccount.mockReset()
  getAccount.mockResolvedValue({ id: '1', username: 'testuser' })
  globalThis.__setTrpcHandler('account.me', getAccount)
  vi.mocked(apiClient.logout).mockReset().mockResolvedValue(undefined)
})

function renderWithUser(ui: React.ReactElement) {
  return render(ui)
}

function getPrimaryNav() {
  return screen.getByRole('navigation', { name: 'navigation.menu' })
}

describe('AppNav - disclosure focus and pending actions', () => {
  it('returns focus to the menu trigger on Escape and backdrop dismissal', () => {
    render(<AppNav />)
    const trigger = screen.getByRole('button', { name: 'navigation.menu' })
    fireEvent.click(trigger)
    const panel = document.getElementById(trigger.getAttribute('aria-controls')!)!
    within(panel).getAllByRole('link')[0].focus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(trigger)
    const backdrop = screen.getAllByRole('button', { name: 'navigation.closeMenu' }).find((button) => button.tabIndex === -1)!
    expect(backdrop).toBeInTheDocument()
    fireEvent.click(backdrop)
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('returns focus to the language trigger on Escape and selection', () => {
    render(<AppNav />)
    const trigger = screen.getByRole('button', { name: 'Language' })
    fireEvent.click(trigger)
    const panel = document.getElementById(trigger.getAttribute('aria-controls')!)!
    within(panel).getByRole('link', { name: '日本語' }).focus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(trigger)
    fireEvent.click(within(document.getElementById(trigger.getAttribute('aria-controls')!)!).getByRole('link', { name: '日本語' }))
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('disables desktop and expanded-menu logout while the request is pending', async () => {
    let finish!: () => void
    vi.mocked(apiClient.logout).mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve }))
    render(<AppNav />)
    fireEvent.click(screen.getByRole('button', { name: 'navigation.menu' }))
    const actions = screen.getAllByRole('button', { name: 'navigation.logout' })
    expect(actions).toHaveLength(2)
    fireEvent.click(actions[0])
    await waitFor(() => actions.forEach((action) => expect(action).toBeDisabled()))
    fireEvent.click(actions[1])
    expect(apiClient.logout).toHaveBeenCalledTimes(1)
    await act(async () => { finish() })
    await waitFor(() => expect(actions[0]).toBeEnabled())
  })

  it('logs out from the expanded menu and closes it on success', async () => {
    const navigate = vi.mocked(useI18nNavigate())
    navigate.mockClear()
    render(<AppNav />)
    const trigger = screen.getByRole('button', { name: 'navigation.menu' })
    fireEvent.click(trigger)
    const panel = document.getElementById(trigger.getAttribute('aria-controls')!)!

    fireEvent.click(within(panel).getByRole('button', { name: 'navigation.logout' }))

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/login'))
    expect(apiClient.logout).toHaveBeenCalledTimes(1)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows logout failure, preserves the current page and cache, and allows retry', async () => {
    const navigate = vi.mocked(useI18nNavigate())
    navigate.mockClear()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(apiClient.logout).mockRejectedValueOnce(new Error('Network error'))
    const { result } = renderHook(() => useQueryClient())
    result.current.setQueryData(['private-videos'], ['current-user-video'])
    render(<AppNav />)
    const logout = screen.getByRole('button', { name: 'navigation.logout' })

    fireEvent.click(logout)

    await screen.findByText('navigation.logoutFailed')
    expect(navigate).not.toHaveBeenCalled()
    expect(result.current.getQueryData(['private-videos'])).toEqual(['current-user-video'])
    await waitFor(() => expect(logout).toBeEnabled())

    fireEvent.click(logout)
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/login'))
    expect(apiClient.logout).toHaveBeenCalledTimes(2)
    expect(result.current.getQueryData(['private-videos'])).toBeUndefined()
    consoleError.mockRestore()
  })
})

describe('AppNav - no authenticated user (empty cache)', () => {
  beforeEach(() => {
    ;(globalThis as any).__setMockAuthSession?.(null)
  })

  it('highlights home link when activePage="home"', () => {
    render(<AppNav activePage="home" />)
    const homeLink = within(getPrimaryNav()).getByText('navigation.home')
    expect(homeLink.closest('a')).toHaveAttribute('aria-current', 'page')
  })

  it('hides videos nav link', () => {
    render(<AppNav />)
    expect(screen.queryByText('navigation.videoLibrary')).not.toBeInTheDocument()
  })

  it('hides courses nav link', () => {
    render(<AppNav />)
    expect(screen.queryByText('navigation.coursesNav')).not.toBeInTheDocument()
  })

  it('hides settings nav link', () => {
    render(<AppNav />)
    expect(screen.queryByText('navigation.settings')).not.toBeInTheDocument()
  })

  it('shows pricing nav link', () => {
    render(<AppNav />)
    expect(within(getPrimaryNav()).getByText('navigation.pricing')).toBeInTheDocument()
  })

  it('keeps signup available in the menu and closes it after tracking the click', () => {
    const track = vi.spyOn(landingAnalytics, 'trackLandingEvent')
    render(<AppNav />)
    const trigger = screen.getByRole('button', { name: 'navigation.menu' })
    fireEvent.click(trigger)
    const panel = document.getElementById(trigger.getAttribute('aria-controls')!)!
    const signup = within(panel).getByRole('link', { name: 'landing.start' })
    expect(signup).toHaveAttribute('href', '/signup')

    // jsdom cannot follow the native link; its destination is checked above.
    signup.addEventListener('click', event => event.preventDefault())
    fireEvent.click(signup)

    expect(track).toHaveBeenCalledWith('signup_click', 'header')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById(trigger.getAttribute('aria-controls')!)).toBeNull()
    track.mockRestore()
  })

  it('shows login button', () => {
    render(<AppNav />)
    expect(screen.getAllByText('auth.login.submit').length).toBeGreaterThan(0)
  })
})

describe('AppNav - authenticated user (cache populated)', () => {
  it('shows videos nav link', () => {
    renderWithUser(<AppNav />)
    expect(within(getPrimaryNav()).getByText('navigation.videoLibrary')).toBeInTheDocument()
  })

  it('shows courses nav link', () => {
    renderWithUser(<AppNav />)
    expect(within(getPrimaryNav()).getByText('navigation.coursesNav')).toBeInTheDocument()
  })

  it('shows settings nav link', () => {
    renderWithUser(<AppNav />)
    expect(within(getPrimaryNav()).getByText('navigation.settings')).toBeInTheDocument()
  })

  it('hides admin nav link for non-admins', () => {
    renderWithUser(<AppNav />)
    expect(screen.queryByText('navigation.admin')).not.toBeInTheDocument()
  })

  it('shows admin nav link for admins', () => {
    getAccount.mockResolvedValue({ id: 1, username: 'admin', is_admin: true })
    render(<AppNav />)
    return waitFor(() => {
      expect(within(getPrimaryNav()).getByText('navigation.admin')).toBeInTheDocument()
    })
  })

})

describe('AppNav - auth cache uninitialized (fetches from API)', () => {
  it('loads app profile via getMeOrNull only when BA session exists', async () => {
    render(<AppNav />)
    await waitFor(() => {
      expect(within(getPrimaryNav()).getByText('navigation.videoLibrary')).toBeInTheDocument()
    })
    expect(getAccount).toHaveBeenCalled()
  })

  it('shows authenticated menu after fetching user from API when cache is empty', async () => {
    getAccount.mockResolvedValue({ id: '1', username: 'testuser' })
    render(<AppNav />)
    await waitFor(() => {
      expect(within(getPrimaryNav()).getByText('navigation.videoLibrary')).toBeInTheDocument()
    })
    expect(screen.queryByText('auth.login.submit')).not.toBeInTheDocument()
  })

  it('shows login button when BA session is absent', async () => {
    vi.clearAllMocks()
    ;(globalThis as any).__setMockAuthSession?.(null)
    render(<AppNav />)
    await waitFor(() => {
      expect(screen.getAllByText('auth.login.submit').length).toBeGreaterThan(0)
    })
    expect(screen.queryByText('navigation.videoLibrary')).not.toBeInTheDocument()
    expect(getAccount).not.toHaveBeenCalled()
  })
})
