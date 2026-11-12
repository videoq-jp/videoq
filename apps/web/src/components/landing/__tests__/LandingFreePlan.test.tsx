import { fireEvent, render, screen } from '@testing-library/react'
import { LandingFreePlan } from '../LandingFreePlan'
import * as landingAnalytics from '@/lib/landingAnalytics'

describe('LandingFreePlan', () => {
  it('shows the limits returned by the pricing catalog, including changed limits', async () => {
    globalThis.__setTrpcHandler('billing.plans', () => [{
      code: 'free', interval: null, lookup_key: null, unit_amount: 0, currency: 'jpy',
      entitlements: { max_video_upload_size_mb: 5237760, monthly_upload_limit_gb: 4, storage_limit_gb: 2, processing_limit_minutes: 60, ai_answers_limit: 40 },
    }])
    render(<LandingFreePlan />)
    expect(await screen.findByText('landing.free.minutes {"minutes":60}')).toBeInTheDocument()
    expect(screen.getByText('landing.free.answerCount {"count":40}')).toBeInTheDocument()
    expect(screen.getByText('landing.free.gb {"gb":2}')).toBeInTheDocument()
    expect(screen.getByText('landing.free.gb {"gb":4}')).toBeInTheDocument()
  })

  it('keeps signup and pricing available if the catalog fails', async () => {
    globalThis.__setTrpcHandler('billing.plans', () => { throw new Error('Unavailable') })
    const track = vi.spyOn(landingAnalytics, 'trackLandingEvent')
    render(<LandingFreePlan />)
    expect(await screen.findByText('landing.free.unavailable')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /landing.start/ })).toHaveAttribute('href', '/signup')
    expect(screen.getByRole('link', { name: /landing.next.pricing.title/ })).toHaveAttribute('href', '/pricing')
    expect(screen.queryByText(/landing.free.minutes/)).not.toBeInTheDocument()

    const signup = screen.getByRole('link', { name: /landing.start/ })
    // Check conversion tracking without navigating away from the test document.
    signup.addEventListener('click', event => event.preventDefault())
    fireEvent.click(signup)
    expect(track).toHaveBeenCalledWith('signup_click', 'free')
    track.mockRestore()
  })
})
