import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { useQueryClient } from '@tanstack/react-query'
import { trpc } from '@/lib/trpc'
import PricingPage from '../PricingPage'

const getPlans = vi.fn()
const getAccount = vi.fn()
const portal = vi.fn()
const checkout = vi.fn()

describe('PricingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.__setMockSearchParams('')
    globalThis.__setMockLanguage('ja')
    globalThis.__setTrpcHandler('account.me', getAccount)
    globalThis.__setTrpcHandler('billing.plans', getPlans)
    globalThis.__setTrpcHandler('billing.portal', portal)
    globalThis.__setTrpcHandler('billing.checkout', checkout)
    portal.mockReset().mockRejectedValue(new Error('Portal unavailable'))
    checkout.mockReset().mockRejectedValue(new Error('Checkout unavailable'))
    getAccount.mockResolvedValue({ id: 1, username: 'testuser', plan_code: 'free' })
    getPlans.mockResolvedValue([
      {
        code: 'free',
        interval: null,
        lookup_key: null,
        unit_amount: 0,
        currency: 'jpy',
        entitlements: {
          max_video_upload_size_mb: 200,
          storage_limit_gb: 1,
          processing_limit_minutes: 45,
          ai_answers_limit: 30,
        },
      },
      {
        code: 'basic',
        interval: 'month',
        lookup_key: 'basic_monthly',
        unit_amount: 1480,
        currency: 'jpy',
        entitlements: {
          max_video_upload_size_mb: 1024,
          storage_limit_gb: 20,
          processing_limit_minutes: 200,
          ai_answers_limit: 500,
        },
      },
    ])
  })

  it('renders plan names from the catalog', async () => {
    render(<PricingPage />)
    expect(await screen.findByText('pricing.plans.free.name')).toBeInTheDocument()
    expect(screen.getByText('pricing.plans.basic.name')).toBeInTheDocument()
  })

  it('requests USD prices for English and keeps cents in the displayed amount', async () => {
    globalThis.__setMockLanguage('en')
    const plans = await getPlans()
    getPlans.mockResolvedValue(plans.map((plan: { code: string }) => ({
      ...plan, currency: 'usd', unit_amount: plan.code === 'free' ? 0 : 999,
    })))
    getPlans.mockClear()
    render(<PricingPage />)
    expect(await screen.findByText(/USD\s*9\.99/)).toBeInTheDocument()
    expect(getPlans).toHaveBeenCalledWith({ locale: 'en' })
    fireEvent.click(screen.getByRole('button', { name: 'pricing.subscribe' }))
    await waitFor(() => expect(checkout).toHaveBeenCalledWith({ lookupKey: 'basic_monthly', locale: 'en' }))
  })

  it('displays Japanese prices in whole yen', async () => {
    render(<PricingPage />)
    expect(await screen.findByText(/￥1,480/)).toBeInTheDocument()
    expect(getPlans).toHaveBeenCalledWith({ locale: 'ja' })
  })

  it('does not reuse a yen catalog after switching to English', async () => {
    const plans = await getPlans()
    getPlans.mockImplementation(({ locale }: { locale: string }) => plans.map((plan: { code: string; unit_amount: number }) => ({
      ...plan, currency: locale === 'en' ? 'usd' : 'jpy',
      unit_amount: locale === 'en' && plan.code === 'basic' ? 999 : plan.unit_amount,
    })))
    const view = render(<PricingPage />)
    expect(await screen.findByText(/￥1,480/)).toBeInTheDocument()
    globalThis.__setMockLanguage('en')
    view.rerender(<PricingPage />)
    expect(await screen.findByText(/USD\s*9\.99/)).toBeInTheDocument()
    expect(screen.queryByText(/￥1,480/)).not.toBeInTheDocument()
  })

  it('keeps the page chrome visible while plans are loading', async () => {
    getPlans.mockImplementation(
      () => new Promise(() => {}),
    )

    render(<PricingPage />)

    expect(screen.getByText('pricing.title')).toBeInTheDocument()
    expect(screen.getByText('pricing.monthly')).toBeInTheDocument()
    expect(screen.getByLabelText('common.messages.loading')).toBeInTheDocument()
    expect(screen.queryByText('pricing.plans.free.name')).not.toBeInTheDocument()
    await waitFor(() => expect(getPlans).toHaveBeenCalledTimes(1))
  })

  it('offers signup links without claiming a current plan for anonymous visitors', async () => {
    globalThis.__setMockAuthSession(null)
    render(<PricingPage />)
    expect(await screen.findByRole('link', { name: 'pricing.startFree' })).toHaveAttribute('href', '/signup')
    expect(screen.getByRole('link', { name: 'pricing.signUpToSubscribe' })).toHaveAttribute('href', '/signup?next=%2Fpricing%3Finterval%3Dmonth')
    expect(screen.queryByText('pricing.currentPlan')).not.toBeInTheDocument()
    expect(getAccount).not.toHaveBeenCalled()
  })

  it.each(['ja', 'en'])('returns anonymous %s yearly buyers to the localized yearly catalog', async locale => {
    globalThis.__setMockLanguage(locale)
    globalThis.__setMockAuthSession(null)
    const plans = await getPlans()
    getPlans.mockResolvedValue(plans.map((plan: { code: string }) => ({
      ...plan, interval: plan.code === 'free' ? null : 'year',
    })))
    globalThis.__setMockSearchParams('?interval=year')
    render(<PricingPage />)
    const link = await screen.findByRole('link', { name: 'pricing.signUpToSubscribe' })
    const next = new URL(link.getAttribute('href')!, 'https://videoq.jp').searchParams.get('next')
    expect(next).toBe(`${locale === 'en' ? '/en' : ''}/pricing?interval=year`)
    expect(screen.getByText('pricing.plans.basic.name')).toBeInTheDocument()
  })

  it('does not offer checkout until the account plan is known, even with cached prices', async () => {
    const { result } = renderHook(() => useQueryClient())
    result.current.setQueryData(trpc.billing.plans.queryKey({ locale: 'ja' }), await getPlans())
    let resolveAccount!: (account: unknown) => void
    getAccount.mockImplementation(() => new Promise(resolve => { resolveAccount = resolve }))
    render(<PricingPage />)
    await waitFor(() => expect(getAccount).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: 'pricing.subscribe' })).not.toBeInTheDocument()
    expect(screen.queryByText('pricing.currentPlan')).not.toBeInTheDocument()
    await act(async () => resolveAccount({ id: '1', plan_code: 'basic' }))
    expect(await screen.findByRole('button', { name: 'pricing.manage' })).toBeEnabled()
    expect(checkout).not.toHaveBeenCalled()
  })

  it('shows portal errors and lets paid users change to the free plan through the portal', async () => {
    getAccount.mockResolvedValue({ id: '1', plan_code: 'basic' })
    render(<PricingPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'pricing.manage' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Portal unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'pricing.changePlan' }))
    await waitFor(() => expect(portal).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('link', { name: 'pricing.startFree' })).not.toBeInTheDocument()
    expect(checkout).not.toHaveBeenCalled()
  })

  it('keeps checkout available for free accounts and displays errors with retry', async () => {
    render(<PricingPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'pricing.subscribe' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Checkout unavailable')
    expect(checkout).toHaveBeenCalledWith(expect.objectContaining({ lookupKey: 'basic_monthly' }))
    fireEvent.click(screen.getByRole('button', { name: 'pricing.subscribe' }))
    await waitFor(() => expect(checkout).toHaveBeenCalledTimes(2))
    expect(portal).not.toHaveBeenCalled()
  })

  it.each(['catalog', 'account'])('shows a failed %s query and recovers after retry', async failure => {
    const { result } = renderHook(() => useQueryClient())
    result.current.setQueryData(trpc.billing.plans.queryKey({ locale: 'ja' }), await getPlans())
    const failing = failure === 'catalog' ? getPlans : getAccount
    failing.mockRejectedValueOnce(new Error('Could not load billing data'))
    render(<PricingPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load billing data')
    if (failure === 'account') expect(screen.queryByRole('button', { name: 'pricing.subscribe' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'pricing.retry' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(await screen.findByRole('button', { name: 'pricing.subscribe' })).toBeEnabled()
  })

  it('prevents duplicate portal requests while a redirect is being prepared', async () => {
    getAccount.mockResolvedValue({ id: '1', plan_code: 'basic' })
    let rejectPortal!: (error: Error) => void
    portal.mockImplementation(() => new Promise((_, reject) => { rejectPortal = reject }))
    render(<PricingPage />)
    const manage = await screen.findByRole('button', { name: 'pricing.manage' })
    fireEvent.click(manage)
    await waitFor(() => expect(portal).toHaveBeenCalledTimes(1))
    expect(manage).toBeDisabled()
    expect(screen.getByRole('button', { name: 'pricing.changePlan' })).toBeDisabled()
    fireEvent.click(manage)
    expect(portal).toHaveBeenCalledTimes(1)
    await act(async () => rejectPortal(new Error('Portal unavailable')))
    expect(await screen.findByRole('alert')).toHaveTextContent('Portal unavailable')
    expect(manage).toBeEnabled()
  })
})
