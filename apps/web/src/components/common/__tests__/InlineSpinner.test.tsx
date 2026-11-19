import { render, screen } from '@testing-library/react'
import { InlineSpinner } from '../InlineSpinner'

describe('InlineSpinner', () => {
  it('uses the shared spinner decoratively so the surrounding action supplies its name', () => {
    const { container } = render(<button>保存中<InlineSpinner /></button>)
    expect(screen.getByRole('button', { name: '保存中' })).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(container.querySelector('[data-slot="progress-indicator-spinner"]')).toBeInTheDocument()
  })
  it('supports danger actions and custom sizing', () => {
    const { container } = render(<InlineSpinner color="red" className="h-4 w-4" />)
    expect(container.querySelector('[data-slot="progress-indicator"]')).toHaveClass('text-error-1', 'h-4', 'w-4')
  })
})
