import { renderHook, act, waitFor } from '@testing-library/react'
import { useAuthForm } from '../useAuthForm'

describe('useAuthForm', () => {
  const initialData = { username: '', password: '' }
  const mockOnSubmit = vi.fn()

  beforeEach(() => {
    mockOnSubmit.mockReset()
  })

  it('should initialize with initial data', () => {
    const { result } = renderHook(() =>
      useAuthForm({
        onSubmit: mockOnSubmit,
        initialData,
      })
    )

    expect(result.current.formData).toEqual(initialData)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('should update form data on change', () => {
    const { result } = renderHook(() =>
      useAuthForm({
        onSubmit: mockOnSubmit,
        initialData,
      })
    )

    act(() => {
      result.current.handleChange({
        target: { name: 'username', value: 'testuser' },
      } as React.ChangeEvent<HTMLInputElement>)
    })

    expect(result.current.formData.username).toBe('testuser')
  })

  it('should handle form submission', async () => {
    mockOnSubmit.mockResolvedValue(undefined)
    const { result } = renderHook(() =>
      useAuthForm({
        onSubmit: mockOnSubmit,
        initialData,
      })
    )

    act(() => {
      result.current.handleChange({
        target: { name: 'username', value: 'testuser' },
      } as React.ChangeEvent<HTMLInputElement>)
    })

    await act(async () => {
      result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    await waitFor(() => {
      expect(mockOnSubmit).toHaveBeenCalledWith({ username: 'testuser', password: '' })
    })
  })

  it('should call onSuccessRedirect on successful submission', async () => {
    mockOnSubmit.mockResolvedValue(undefined)
    const onSuccessRedirect = vi.fn()
    const { result } = renderHook(() =>
      useAuthForm({
        onSubmit: mockOnSubmit,
        initialData,
        onSuccessRedirect,
      })
    )

    await act(async () => {
      result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent)
    })

    await waitFor(() => {
      expect(onSuccessRedirect).toHaveBeenCalled()
    })
  })

  it('should handle submission errors', async () => {
    const error = new Error('Submission failed')
    mockOnSubmit.mockRejectedValue(error)
    const { result } = renderHook(() =>
      useAuthForm({
        onSubmit: mockOnSubmit,
        initialData,
      })
    )

    act(() => {
      expect(result.current.handleSubmit({
        preventDefault: vi.fn(),
      } as unknown as React.FormEvent<HTMLFormElement>)).toBeUndefined()
    })

    await waitFor(() => {
      expect(result.current.error).toBe('Submission failed')
    })
  })

  it('blocks repeated submits until the current request settles and allows retry', async () => {
    let reject!: (error: Error) => void
    mockOnSubmit.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
      .mockResolvedValue(undefined)
    const onSuccessRedirect = vi.fn()
    const { result } = renderHook(() =>
      useAuthForm({
        onSubmit: mockOnSubmit,
        initialData,
        onSuccessRedirect,
      })
    )
    const event = { preventDefault: vi.fn() } as unknown as React.FormEvent<HTMLFormElement>
    act(() => {
      result.current.handleSubmit(event)
      result.current.handleSubmit(event)
    })
    await waitFor(() => expect(mockOnSubmit).toHaveBeenCalledTimes(1))
    expect(result.current.isLoading).toBe(true)
    await act(async () => { reject(new Error('Please retry')) })
    await waitFor(() => expect(result.current.error).toBe('Please retry'))
    expect(onSuccessRedirect).not.toHaveBeenCalled()
    act(() => { result.current.handleSubmit(event) })
    await waitFor(() => expect(onSuccessRedirect).toHaveBeenCalledTimes(1))
    expect(result.current.error).toBeNull()
    expect(result.current.isLoading).toBe(false)
    expect(mockOnSubmit).toHaveBeenCalledTimes(2)
  })
})
