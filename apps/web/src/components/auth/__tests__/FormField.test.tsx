import { render, screen, fireEvent } from '@testing-library/react'
import { FormField } from '../FormField'

describe('FormField', () => {
  const defaultProps = {
    id: 'username',
    name: 'username',
    label: 'Username',
    type: 'text',
    value: '',
    onChange: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should render label and input', () => {
    render(<FormField {...defaultProps} />)
    
    expect(screen.getByLabelText('Username')).toBeInTheDocument()
    expect(screen.getByLabelText(/Username/)).toBeInTheDocument()
  })

  it('should call onChange when input changes', () => {
    const onChange = vi.fn()
    render(<FormField {...defaultProps} onChange={onChange} />)
    
    const input = screen.getByLabelText(/Username/)
    fireEvent.change(input, { target: { value: 'testuser' } })
    
    expect(onChange).toHaveBeenCalled()
  })

  it('should set required attribute when required is true', () => {
    render(<FormField {...defaultProps} required={true} />)
    
    const input = screen.getByLabelText(/Username/)
    expect(input).toHaveAttribute('required')
  })

  it('should set minLength attribute when provided', () => {
    render(<FormField {...defaultProps} minLength={5} />)
    
    const input = screen.getByLabelText(/Username/)
    expect(input).toHaveAttribute('minLength', '5')
  })

  it('should display value', () => {
    render(<FormField {...defaultProps} value="testuser" />)
    
    const input = screen.getByLabelText<HTMLInputElement>(/Username/)
    expect(input.value).toBe('testuser')
  })

  it('describes the input with only the visible support or error text', () => {
    const { rerender } = render(
      <FormField {...defaultProps} supportText="Use at least 3 characters." />,
    )
    const input = screen.getByLabelText('Username')
    expect(input).toHaveAccessibleDescription('Use at least 3 characters.')
    expect(input).toHaveAttribute('aria-describedby', 'username-support')

    rerender(
      <FormField {...defaultProps} supportText="Use at least 3 characters." error="Username is already taken." />,
    )
    expect(input).toHaveAccessibleDescription('Username is already taken.')
    expect(input).toHaveAttribute('aria-describedby', 'username-error')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.queryByText('Use at least 3 characters.')).not.toBeInTheDocument()

    rerender(<FormField {...defaultProps} supportText="Use at least 3 characters." />)
    expect(input).toHaveAccessibleDescription('Use at least 3 characters.')
    expect(input).not.toHaveAttribute('aria-invalid')

    rerender(<FormField {...defaultProps} />)
    expect(input).not.toHaveAttribute('aria-describedby')
  })
})
