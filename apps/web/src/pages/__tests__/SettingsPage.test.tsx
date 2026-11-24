import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { useQueryClient } from '@tanstack/react-query'
import SettingsPage from '../SettingsPage'
import { apiClient, type IntegrationApiKey } from '@/lib/api'
import { trpc } from '@/lib/trpc'

const listApiKeys = vi.fn<() => Promise<IntegrationApiKey[]>>();
beforeEach(() => {
  listApiKeys.mockReset().mockResolvedValue([]);
  globalThis.__setTrpcHandler('account.integrationApiKeys', listApiKeys);
  globalThis.__setTrpcHandler('account.connectedApps', () => []);
});

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: {
      id: 1,
      username: 'alice',
      email: 'alice@example.com',
      video_count: 0,
      max_video_upload_size_mb: 500,
    },
    isLoading: false,
    refetch: vi.fn(),
  }),
}))

vi.mock('@/lib/api', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    apiClient: {
      requestEmailChange: vi.fn(() => Promise.resolve()),
      updateUsername: vi.fn(() => Promise.resolve()),
      createIntegrationApiKey: vi.fn(),
      revokeIntegrationApiKey: vi.fn(),
    },
  }
})

describe('SettingsPage email change', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.__setTrpcHandler('account.searchApiKeyStatus', () => ({ has_api_key: false }))
  })

  it('renders the current email address without opening the change form', async () => {
    render(<SettingsPage />)

    expect(await screen.findByText('settings.emailChange.title')).toBeInTheDocument()
    expect(screen.getByText('alice@example.com')).toBeInTheDocument()
    expect(screen.queryByLabelText('settings.emailChange.newEmailLabel')).not.toBeInTheDocument()
  })

  it('requests an email change from the settings form', async () => {
    render(<SettingsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'settings.emailChange.edit' }))
    const input = await screen.findByLabelText('settings.emailChange.newEmailLabel')
    fireEvent.change(input, { target: { value: 'new@example.com' } })
    fireEvent.click(screen.getByText('settings.emailChange.submit'))

    await waitFor(() => {
      expect(apiClient.requestEmailChange).toHaveBeenCalledWith({ email: 'new@example.com' })
    })
    expect(await screen.findByText('settings.emailChange.success')).toBeInTheDocument()
  })

  it('does not call the API when the new email is empty', async () => {
    render(<SettingsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'settings.emailChange.edit' }))
    const input = await screen.findByLabelText('settings.emailChange.newEmailLabel')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(screen.getByText('settings.emailChange.submit'))

    expect(apiClient.requestEmailChange).not.toHaveBeenCalled()
    expect(screen.getByText('settings.emailChange.submit')).toBeDisabled()
  })
})

describe('SettingsPage username change', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.__setTrpcHandler('account.searchApiKeyStatus', () => ({ has_api_key: false }))
  })

  it('renders the current username without opening the change form', async () => {
    render(<SettingsPage />)

    expect(await screen.findByText('settings.usernameChange.title')).toBeInTheDocument()
    expect(screen.getByText('alice')).toBeInTheDocument()
    expect(screen.queryByLabelText('settings.usernameChange.newUsernameLabel')).not.toBeInTheDocument()
  })

  it('updates the username from the settings form', async () => {
    render(<SettingsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'settings.usernameChange.edit' }))
    const input = await screen.findByLabelText('settings.usernameChange.newUsernameLabel')
    fireEvent.change(input, { target: { value: 'alice_new' } })
    fireEvent.click(screen.getByText('settings.usernameChange.submit'))

    await waitFor(() => {
      expect(apiClient.updateUsername).toHaveBeenCalledWith({ username: 'alice_new' })
    })
    expect(await screen.findByText('settings.usernameChange.success')).toBeInTheDocument()
  })

  it('does not call the API when the username is empty', async () => {
    render(<SettingsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'settings.usernameChange.edit' }))
    const input = await screen.findByLabelText('settings.usernameChange.newUsernameLabel')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(screen.getByText('settings.usernameChange.submit'))

    expect(apiClient.updateUsername).not.toHaveBeenCalled()
    expect(screen.getByText('settings.usernameChange.submit')).toBeDisabled()
  })

  it('does not call the API when the username is unchanged', async () => {
    render(<SettingsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'settings.usernameChange.edit' }))
    const input = await screen.findByLabelText('settings.usernameChange.newUsernameLabel')
    await waitFor(() => {
      expect(input).toHaveValue('alice')
    })
    fireEvent.click(screen.getByText('settings.usernameChange.submit'))

    expect(apiClient.updateUsername).not.toHaveBeenCalled()
    expect(screen.getByText('settings.usernameChange.submit')).toBeDisabled()
  })

  it('maps a taken username error to the settings copy', async () => {
    vi.mocked(apiClient.updateUsername).mockRejectedValueOnce(
      Object.assign(new Error('Username is already taken'), {
        code: 'USERNAME_IS_ALREADY_TAKEN',
      }),
    )
    render(<SettingsPage />)

    fireEvent.click(screen.getByRole('button', { name: 'settings.usernameChange.edit' }))
    const input = await screen.findByLabelText('settings.usernameChange.newUsernameLabel')
    fireEvent.change(input, { target: { value: 'taken_name' } })
    fireEvent.click(screen.getByText('settings.usernameChange.submit'))

    expect(await screen.findByText('settings.usernameChange.errorTaken')).toBeInTheDocument()
  })
})


describe('SettingsPage interactions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listApiKeys.mockReset().mockResolvedValue([])
    vi.mocked(apiClient.createIntegrationApiKey).mockReset()
    vi.mocked(apiClient.revokeIntegrationApiKey).mockReset()
    globalThis.__setTrpcHandler('account.searchApiKeyStatus', () => ({ has_api_key: false }))
  })

  it('groups settings by task and links to each section', () => {
    render(<SettingsPage />)
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'settings.account.title', 'settings.billing.title', 'settings.searchApiKey.title', 'settings.integrations.title',
    ])
    const navigation = screen.getByRole('navigation', { name: 'settings.navigation' })
    for (const link of within(navigation).getAllByRole('link')) {
      expect(document.querySelector(link.getAttribute('href')!)).toBeInTheDocument()
    }
  })

  it('discards a cancelled edit and returns focus to its change button', () => {
    render(<SettingsPage />)
    const edit = screen.getByRole('button', { name: 'settings.usernameChange.edit' })
    fireEvent.click(edit)
    const input = screen.getByLabelText('settings.usernameChange.newUsernameLabel')
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: 'unsaved' } })
    fireEvent.click(within(screen.getByRole('form')).getByRole('button', { name: 'settings.cancel' }))
    expect(edit).toHaveFocus()
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    expect(apiClient.updateUsername).not.toHaveBeenCalled()
    fireEvent.click(edit)
    expect(screen.getByLabelText('settings.usernameChange.newUsernameLabel')).toHaveValue('alice')
  })

  it('keeps the current email until verification and closes the editor after sending', async () => {
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.emailChange.edit' }))
    fireEvent.change(screen.getByLabelText('settings.emailChange.newEmailLabel'), { target: { value: 'new@example.com' } })
    fireEvent.click(screen.getByText('settings.emailChange.submit'))
    expect(await screen.findByText('settings.emailChange.success')).toBeInTheDocument()
    expect(screen.getByText('alice@example.com')).toBeInTheDocument()
    expect(screen.queryByLabelText('settings.emailChange.newEmailLabel')).not.toBeInTheDocument()
  })

  it('masks the TranscriptAPI key and prevents empty saves', async () => {
    render(<SettingsPage />)
    const input = await screen.findByLabelText('settings.searchApiKey.apiKeyLabel')
    expect(input).toHaveAttribute('type', 'password')
    expect(screen.getByRole('button', { name: 'settings.searchApiKey.save' })).toBeDisabled()
    fireEvent.change(input, { target: { value: 'fixture-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'settings.searchApiKey.show' }))
    expect(input).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'settings.searchApiKey.save' })).toBeEnabled()
  })

  it('confirms TranscriptAPI deletion before calling the API', async () => {
    const remove = vi.fn(() => ({ success: true }))
    globalThis.__setTrpcHandler('account.searchApiKeyStatus', () => ({ has_api_key: true }))
    globalThis.__setTrpcHandler('account.deleteSearchApiKey', remove)
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'settings.searchApiKey.delete' }))
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'settings.cancel' }))
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'settings.searchApiKey.delete' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'settings.searchApiKey.delete' }))
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('shows a load error instead of claiming TranscriptAPI is not configured', async () => {
    globalThis.__setTrpcHandler('account.searchApiKeyStatus', () => { throw new Error('Unavailable') })
    render(<SettingsPage />)
    expect(await screen.findByText('settings.searchApiKey.errorLoading')).toBeInTheDocument()
    expect(screen.queryByText('settings.searchApiKey.notConfigured')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('settings.searchApiKey.apiKeyLabel')).not.toBeInTheDocument()
  })

  it('keeps one status retry in flight after a background load failure', async () => {
    let finish!: (value: { has_api_key: boolean }) => void
    const read = vi.fn().mockRejectedValueOnce(new Error('Unavailable'))
      .mockImplementation(() => new Promise(resolve => { finish = resolve }))
    globalThis.__setTrpcHandler('account.searchApiKeyStatus', read)
    const { result } = renderHook(() => useQueryClient())
    result.current.setQueryData(trpc.account.searchApiKeyStatus.queryKey(), { has_api_key: false })
    render(<SettingsPage />)
    const retry = await screen.findByRole('button', { name: 'settings.retry' })
    act(() => { fireEvent.click(retry); fireEvent.click(retry) })
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    expect(retry).toBeDisabled()
    await act(async () => { finish({ has_api_key: true }) })
    expect(await screen.findByText('settings.searchApiKey.configured')).toBeInTheDocument()
    expect(screen.queryByText('settings.searchApiKey.errorLoading')).not.toBeInTheDocument()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it.each(['save', 'delete'] as const)('keeps the existing TranscriptAPI status after a failed %s and permits retry', async (action) => {
    const initial = { has_api_key: action === 'delete' }
    const read = vi.fn(() => initial)
    const update = vi.fn().mockRejectedValueOnce(new Error('Please retry')).mockResolvedValue({ success: true })
    globalThis.__setTrpcHandler('account.searchApiKeyStatus', read)
    globalThis.__setTrpcHandler(`account.${action}SearchApiKey`, update)
    render(<SettingsPage />)
    await screen.findByText(`settings.searchApiKey.${initial.has_api_key ? 'configured' : 'notConfigured'}`)
    const submit = () => {
      if (action === 'save') {
        fireEvent.click(screen.getByRole('button', { name: 'settings.searchApiKey.save' }))
      } else {
        fireEvent.click(screen.getByRole('button', { name: 'settings.searchApiKey.delete' }))
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'settings.searchApiKey.delete' }))
      }
    }
    if (action === 'save') fireEvent.change(screen.getByLabelText('settings.searchApiKey.apiKeyLabel'), { target: { value: 'fixture-key' } })
    submit()
    await screen.findByText('Please retry')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByText(`settings.searchApiKey.${initial.has_api_key ? 'configured' : 'notConfigured'}`)).toBeInTheDocument()
    if (action === 'save') expect(screen.getByLabelText('settings.searchApiKey.apiKeyLabel')).toHaveValue('fixture-key')
    submit()
    await screen.findByText(`settings.searchApiKey.${action === 'save' ? 'successSaved' : 'successDeleted'}`)
    expect(update).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('saves a trimmed TranscriptAPI key and collapses the configured editor', async () => {
    let configured = false
    const save = vi.fn(() => { configured = true; return { success: true } })
    const read = vi.fn(() => ({ has_api_key: configured }))
    globalThis.__setTrpcHandler('account.searchApiKeyStatus', read)
    globalThis.__setTrpcHandler('account.saveSearchApiKey', save)
    render(<SettingsPage />)
    fireEvent.change(await screen.findByLabelText('settings.searchApiKey.apiKeyLabel'), { target: { value: '  fixture-key  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'settings.searchApiKey.save' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({ apiKey: 'fixture-key' }))
    expect(await screen.findByText('settings.searchApiKey.configured')).toBeInTheDocument()
    expect(screen.queryByLabelText('settings.searchApiKey.apiKeyLabel')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'settings.searchApiKey.edit' }))
    expect(screen.getByLabelText('settings.searchApiKey.apiKeyLabel')).toHaveValue('')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it.each(['save', 'delete'] as const)('keeps TranscriptAPI %s results when an older status read finishes later', async (action) => {
    const initial = { has_api_key: action === 'delete' }
    let finish!: (value: typeof initial) => void
    const pending = new Promise<typeof initial>(resolve => { finish = resolve })
    const read = vi.fn().mockResolvedValueOnce(initial).mockReturnValueOnce(pending).mockResolvedValue(initial)
    globalThis.__setTrpcHandler('account.searchApiKeyStatus', read)
    const mutation = vi.fn(() => ({ success: true }))
    globalThis.__setTrpcHandler(`account.${action}SearchApiKey`, mutation)
    const { result } = renderHook(() => useQueryClient())
    render(<SettingsPage />)
    await screen.findByText(`settings.searchApiKey.${initial.has_api_key ? 'configured' : 'notConfigured'}`)
    let fetching!: Promise<void>
    act(() => { fetching = result.current.refetchQueries(trpc.account.searchApiKeyStatus.queryFilter()) })
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    if (action === 'save') {
      fireEvent.change(screen.getByLabelText('settings.searchApiKey.apiKeyLabel'), { target: { value: 'fixture-key' } })
      fireEvent.click(screen.getByRole('button', { name: 'settings.searchApiKey.save' }))
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'settings.searchApiKey.delete' }))
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'settings.searchApiKey.delete' }))
    }
    await screen.findByText(`settings.searchApiKey.${action === 'save' ? 'successSaved' : 'successDeleted'}`)
    await act(async () => { finish(initial); await fetching })
    await waitFor(() => expect(result.current.getQueryData(trpc.account.searchApiKeyStatus.queryKey()))
      .toEqual({ has_api_key: !initial.has_api_key }))
    expect(read).toHaveBeenCalledTimes(2)
    expect(mutation).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('settings.searchApiKey.errorLoading')).not.toBeInTheDocument()
  })

  it('removes a revoked key without another list read and ignores a stale list response', async () => {
    const key = { id: 'key-to-revoke', config_id: 'read-write', name: 'Notes', prefix: 'vq_test',
      access_level: 'all' as const, last_used_at: null, created_at: '2026-09-01T00:00:00Z' }
    let finish!: (keys: typeof key[]) => void
    const pending = new Promise<typeof key[]>(resolve => { finish = resolve })
    listApiKeys.mockResolvedValueOnce([key]).mockReturnValueOnce(pending)
    vi.mocked(apiClient.revokeIntegrationApiKey).mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useQueryClient())
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'settings.integrationApiKeys.revoke: Notes' }))
    let fetching!: Promise<void>
    act(() => { fetching = result.current.refetchQueries({ queryKey: trpc.account.integrationApiKeys.queryKey() }) })
    await waitFor(() => expect(listApiKeys).toHaveBeenCalledTimes(2))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'settings.integrationApiKeys.revokeConfirmCta' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await act(async () => { finish([key]); await fetching })
    expect(screen.queryByText('Notes')).not.toBeInTheDocument()
    expect(result.current.getQueryData(trpc.account.integrationApiKeys.queryKey())).toEqual([])
    expect(listApiKeys).toHaveBeenCalledTimes(2)
    expect(apiClient.revokeIntegrationApiKey).toHaveBeenCalledExactlyOnceWith(key.id, key.config_id)
  })

  it('uses the selected key configuration even when the list changes during confirmation', async () => {
    const key = { id: 'key-to-revoke', config_id: 'read-write', name: 'Notes', prefix: 'vq_test',
      access_level: 'all' as const, last_used_at: null, created_at: '2026-09-01T00:00:00Z' }
    listApiKeys.mockResolvedValueOnce([key])
    vi.mocked(apiClient.revokeIntegrationApiKey).mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useQueryClient())
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'settings.integrationApiKeys.revoke: Notes' }))
    await act(async () => { result.current.setQueryData(trpc.account.integrationApiKeys.queryKey(), []) })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'settings.integrationApiKeys.revokeConfirmCta' }))
    await waitFor(() => expect(apiClient.revokeIntegrationApiKey).toHaveBeenCalledExactlyOnceWith(key.id, key.config_id))
  })

  it('adds the created key without another list read or caching its secret', async () => {
    const oldKey = { id: 'old-key', config_id: 'read-write', name: 'Old notes', prefix: 'vq_old',
      access_level: 'all' as const, last_used_at: null, created_at: '2026-09-01T00:00:00Z' }
    const newKey = { ...oldKey, id: 'new-key', name: 'New notes', prefix: 'vq_new' }
    let finish!: (key: typeof newKey & { api_key: string }) => void
    listApiKeys.mockResolvedValueOnce([oldKey])
    vi.mocked(apiClient.createIntegrationApiKey).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    vi.mocked(apiClient.revokeIntegrationApiKey).mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useQueryClient())
    render(<SettingsPage />)
    const revoke = await screen.findByRole('button', { name: 'settings.integrationApiKeys.revoke: Old notes' })
    const create = screen.getByRole('button', { name: 'settings.integrationApiKeys.create' })
    fireEvent.click(create)
    fireEvent.change(screen.getByLabelText('settings.integrationApiKeys.nameLabel'), { target: { value: newKey.name } })
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.createDialogCta' }))
    await waitFor(() => expect(apiClient.createIntegrationApiKey).toHaveBeenCalledTimes(1))
    expect(create).toBeDisabled()
    expect(revoke).toBeDisabled()
    await act(async () => { finish({ ...newKey, api_key: 'fixture-created-secret' }) })
    await screen.findByText('fixture-created-secret')
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.generatedDoneCta' }))
    await waitFor(() => expect(revoke).toBeEnabled())
    expect(create).toBeEnabled()
    expect(result.current.getQueryData(trpc.account.integrationApiKeys.queryKey())).toEqual([newKey, oldKey])
    fireEvent.click(revoke)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'settings.integrationApiKeys.revokeConfirmCta' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByText(newKey.name)).toBeInTheDocument()
    expect(screen.queryByText(oldKey.name)).not.toBeInTheDocument()
    expect(listApiKeys).toHaveBeenCalledTimes(1)
  })

  it('preserves a newly created key when an older list request finishes later', async () => {
    const oldKey = { id: 'old-key', config_id: 'default', name: 'Old notes', prefix: 'vq_old',
      access_level: 'read_only' as const, last_used_at: null, created_at: '2026-09-01T00:00:00Z' }
    const newKey = { ...oldKey, id: 'new-key', name: 'New notes', prefix: 'vq_new' }
    let finish!: (keys: typeof oldKey[]) => void
    listApiKeys.mockResolvedValueOnce([oldKey])
      .mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    vi.mocked(apiClient.createIntegrationApiKey).mockResolvedValueOnce({ ...newKey, api_key: 'fixture-created-secret' })
    const { result } = renderHook(() => useQueryClient())
    render(<SettingsPage />)
    await screen.findByText(oldKey.name)
    let fetching!: Promise<void>
    act(() => { fetching = result.current.refetchQueries({ queryKey: trpc.account.integrationApiKeys.queryKey() }) })
    await waitFor(() => expect(listApiKeys).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.create' }))
    fireEvent.change(screen.getByLabelText('settings.integrationApiKeys.nameLabel'), { target: { value: newKey.name } })
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.createDialogCta' }))
    await screen.findByText('fixture-created-secret')
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.generatedDoneCta' }))
    await act(async () => { finish([oldKey]); await fetching })
    expect(result.current.getQueryData(trpc.account.integrationApiKeys.queryKey())).toEqual([newKey, oldKey])
    expect(screen.getByRole('button', { name: 'settings.integrationApiKeys.revoke: New notes' })).toBeEnabled()
    expect(listApiKeys).toHaveBeenCalledTimes(2)
  })

  it('keeps newer key metadata when a completed refetch already includes the created key', async () => {
    const newKey = { id: 'new-key', config_id: 'default', name: 'Notes', prefix: 'vq_new',
      access_level: 'read_only' as const, last_used_at: null, created_at: '2026-09-01T00:00:00Z' }
    const currentKey = { ...newKey, last_used_at: '2026-09-24T00:00:00Z' }
    let finish!: (key: typeof newKey & { api_key: string }) => void
    listApiKeys.mockResolvedValueOnce([])
    vi.mocked(apiClient.createIntegrationApiKey).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const { result } = renderHook(() => useQueryClient())
    render(<SettingsPage />)
    await screen.findByText('settings.integrationApiKeys.empty')
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.create' }))
    fireEvent.change(screen.getByLabelText('settings.integrationApiKeys.nameLabel'), { target: { value: newKey.name } })
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.createDialogCta' }))
    await waitFor(() => expect(apiClient.createIntegrationApiKey).toHaveBeenCalledTimes(1))
    await act(async () => {
      result.current.setQueryData(trpc.account.integrationApiKeys.queryKey(), [currentKey])
      finish({ ...newKey, api_key: 'fixture-created-secret' })
    })
    await screen.findByText('fixture-created-secret')
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.generatedDoneCta' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.integrationApiKeys.create' })).toBeEnabled())
    expect(result.current.getQueryData(trpc.account.integrationApiKeys.queryKey())).toEqual([currentKey])
    expect(listApiKeys).toHaveBeenCalledTimes(1)
  })

  it.each(['loading', 'failed'])('reloads the complete key list when the initial read is %s during creation', async (state) => {
    const oldKey = { id: 'old-key', config_id: 'default', name: 'Old notes', prefix: 'vq_old',
      access_level: 'read_only' as const, last_used_at: null, created_at: '2026-09-01T00:00:00Z' }
    const newKey = { ...oldKey, id: 'new-key', name: 'New notes', prefix: 'vq_new' }
    let finishInitial!: (keys: typeof oldKey[]) => void
    const initial = new Promise<typeof oldKey[]>(resolve => { finishInitial = resolve })
    let finishReload!: (keys: typeof oldKey[]) => void
    if (state === 'loading') listApiKeys.mockReturnValueOnce(initial)
    else listApiKeys.mockRejectedValueOnce(new Error('Unavailable'))
    listApiKeys.mockReturnValueOnce(new Promise(resolve => { finishReload = resolve }))
    vi.mocked(apiClient.createIntegrationApiKey).mockResolvedValueOnce({ ...newKey, api_key: 'fixture-created-secret' })
    const { result } = renderHook(() => useQueryClient())
    render(<SettingsPage />)
    if (state === 'failed') await screen.findByText('settings.integrationApiKeys.errorLoading')
    else await waitFor(() => expect(listApiKeys).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.create' }))
    fireEvent.change(screen.getByLabelText('settings.integrationApiKeys.nameLabel'), { target: { value: newKey.name } })
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.createDialogCta' }))
    await screen.findByText('fixture-created-secret')
    await waitFor(() => expect(listApiKeys).toHaveBeenCalledTimes(2))
    expect(result.current.getQueryData(trpc.account.integrationApiKeys.queryKey())).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.generatedDoneCta' }))
    expect(screen.getByRole('button', { name: 'settings.integrationApiKeys.create' })).toBeDisabled()
    await act(async () => { finishReload([newKey, oldKey]) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.integrationApiKeys.create' })).toBeEnabled())
    await act(async () => { finishInitial([oldKey]); await initial })
    expect(result.current.getQueryData(trpc.account.integrationApiKeys.queryKey())).toEqual([newKey, oldKey])
    expect(listApiKeys).toHaveBeenCalledTimes(2)
  })

  it('creates a developer key with the selected permissions', async () => {
    vi.mocked(apiClient.createIntegrationApiKey).mockResolvedValueOnce({
      id: 'key-1', name: 'Notes', prefix: 'vq_test', access_level: 'read_only',
      last_used_at: null, created_at: '2026-09-01T00:00:00Z', api_key: 'fixture-only-secret',
    })
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.create' }))
    fireEvent.change(screen.getByLabelText('settings.integrationApiKeys.nameLabel'), { target: { value: 'Notes' } })
    fireEvent.click(screen.getByRole('button', { name: /settings.integrationApiKeys.permissions.readOnlyTitle/ }))
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.createDialogCta' }))
    await waitFor(() => expect(apiClient.createIntegrationApiKey).toHaveBeenCalledWith({ name: 'Notes', access_level: 'read_only' }))
    expect(await screen.findByText('fixture-only-secret')).toBeInTheDocument()
  })

  it('requires confirmation and displays revoke failures inside the key dialog', async () => {
    listApiKeys.mockResolvedValueOnce([{
      id: 'key-1', config_id: 'read-write', name: 'Notes', prefix: 'vq_test', access_level: 'all',
      last_used_at: null, created_at: '2026-09-01T00:00:00Z',
    }])
    vi.mocked(apiClient.revokeIntegrationApiKey).mockRejectedValueOnce(new Error('Please retry'))
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'settings.integrationApiKeys.revoke: Notes' }))
    expect(apiClient.revokeIntegrationApiKey).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.integrationApiKeys.revokeConfirmCta' }))
    expect(await within(dialog).findByText('Please retry')).toBeInTheDocument()
    expect(apiClient.revokeIntegrationApiKey).toHaveBeenCalledWith('key-1', 'read-write')
  })
})

describe('generated API key copy', () => {
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const secureDescriptor = Object.getOwnPropertyDescriptor(window, 'isSecureContext')
  const writeText = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    writeText.mockReset().mockResolvedValue(undefined)
    listApiKeys.mockReset().mockResolvedValue([])
    vi.mocked(apiClient.createIntegrationApiKey).mockReset()
    globalThis.__setTrpcHandler('account.searchApiKeyStatus', () => ({ has_api_key: false }))
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  })

  afterEach(() => {
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
    if (secureDescriptor) Object.defineProperty(window, 'isSecureContext', secureDescriptor)
    else Reflect.deleteProperty(window, 'isSecureContext')
  })

  async function generateKey(id: string) {
    vi.mocked(apiClient.createIntegrationApiKey).mockResolvedValueOnce({
      id, name: id, config_id: 'default', prefix: 'vq_fixture', access_level: 'read_only',
      last_used_at: null, created_at: '2026-09-01T00:00:00Z', api_key: `fixture-secret-${id}`,
    })
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.create' }))
    fireEvent.change(screen.getByLabelText('settings.integrationApiKeys.nameLabel'), { target: { value: id } })
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.createDialogCta' }))
    await screen.findByText(`fixture-secret-${id}`)
  }

  it('displays clipboard rejection and allows a successful retry', async () => {
    writeText.mockRejectedValueOnce(new Error('Clipboard denied'))
    render(<SettingsPage />)
    await generateKey('first')
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.copy' }))
    expect(await screen.findByText('settings.integrationApiKeys.errorCopying')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.copy' }))
    expect(await screen.findByRole('button', { name: 'settings.integrationApiKeys.copyDone' })).toBeEnabled()
    expect(screen.queryByText('settings.integrationApiKeys.errorCopying')).not.toBeInTheDocument()
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(writeText).toHaveBeenLastCalledWith('fixture-secret-first')
  })

  it.each(['success', 'failure'] as const)('ignores a late copy %s after the dialog is replaced', async (outcome) => {
    let finish!: () => void
    let fail!: (error: Error) => void
    writeText.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = reject }))
    render(<SettingsPage />)
    await generateKey('first')
    const copy = screen.getByRole('button', { name: 'settings.integrationApiKeys.copy' })
    fireEvent.click(copy)
    await waitFor(() => expect(copy).toBeDisabled())
    expect(copy).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.generatedDoneCta' }))
    await generateKey('second')
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.copy' }))
    await screen.findByRole('button', { name: 'settings.integrationApiKeys.copyDone' })
    await act(async () => { if (outcome === 'success') finish(); else fail(new Error('Old copy failed')) })
    expect(screen.getByRole('button', { name: 'settings.integrationApiKeys.copyDone' })).toBeEnabled()
    expect(screen.queryByText('settings.integrationApiKeys.errorCopying')).not.toBeInTheDocument()
    expect(screen.getByText('fixture-secret-second')).toBeInTheDocument()
  })

  it('clears temporary copy feedback after two seconds while retaining the one-time secret', async () => {
    render(<SettingsPage />)
    await generateKey('timed')
    vi.useFakeTimers()
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.copy' }))
        await Promise.resolve()
      })
      expect(screen.getByRole('button', { name: 'settings.integrationApiKeys.copyDone' })).toBeEnabled()
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(screen.getByRole('button', { name: 'settings.integrationApiKeys.copy' })).toBeEnabled()
      expect(screen.getByText('fixture-secret-timed')).toBeInTheDocument()
    } finally { vi.useRealTimers() }
  })

  it('reports clipboard unavailability without claiming the key was copied', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })
    render(<SettingsPage />)
    await generateKey('first')
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.copy' }))
    expect(await screen.findByText('settings.integrationApiKeys.errorCopying')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'settings.integrationApiKeys.copyDone' })).not.toBeInTheDocument()
    expect(writeText).not.toHaveBeenCalled()
  })
})

describe('integration key dialog recovery', () => {
  const key: IntegrationApiKey = {
    id: 'recovery-key', config_id: 'read-write', name: 'Recovery notes', prefix: 'vq_recovery',
    access_level: 'all', last_used_at: null, created_at: '2026-09-01T00:00:00Z',
  }

  beforeEach(() => {
    vi.mocked(apiClient.createIntegrationApiKey).mockReset()
    vi.mocked(apiClient.revokeIntegrationApiKey).mockReset()
    globalThis.__setTrpcHandler('account.searchApiKeyStatus', () => ({ has_api_key: false }))
  })

  it.each(['escape', 'button'])('discards a cancelled create form through %s without creating a key', async method => {
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.create' }))
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.createDialogCta' }))
    expect(screen.getByText('settings.integrationApiKeys.errorEmpty')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('settings.integrationApiKeys.nameLabel'), { target: { value: 'Discard me' } })
    fireEvent.click(screen.getByRole('button', { name: /settings.integrationApiKeys.permissions.readOnlyTitle/ }))
    if (method === 'escape') fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    else fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'settings.integrationApiKeys.cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.create' }))
    expect(screen.getByLabelText('settings.integrationApiKeys.nameLabel')).toHaveValue('')
    expect(screen.getByRole('button', { name: /settings.integrationApiKeys.permissions.allTitle/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('settings.integrationApiKeys.errorEmpty')).not.toBeInTheDocument()
    expect(apiClient.createIntegrationApiKey).not.toHaveBeenCalled()
  })

  it.each([new Error('Creation unavailable'), 'non-error rejection'])('keeps the create form during a request and permits retry after %s', async failure => {
    let reject!: (reason: unknown) => void
    vi.mocked(apiClient.createIntegrationApiKey).mockReturnValueOnce(new Promise((_, fail) => { reject = fail }))
      .mockResolvedValueOnce({ ...key, api_key: 'fixture-recovery-secret' })
    render(<SettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.create' }))
    fireEvent.change(screen.getByLabelText('settings.integrationApiKeys.nameLabel'), { target: { value: '  Recovery notes  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.createDialogCta' }))
    await waitFor(() => expect(apiClient.createIntegrationApiKey).toHaveBeenCalledTimes(1))
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'settings.integrationApiKeys.cancel' })).toBeDisabled()
    await act(async () => { reject(failure) })
    await screen.findByText(failure instanceof Error ? failure.message : 'settings.integrationApiKeys.errorCreating')
    expect(screen.getByLabelText('settings.integrationApiKeys.nameLabel')).toHaveValue('  Recovery notes  ')
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.createDialogCta' }))
    await screen.findByText('fixture-recovery-secret')
    expect(apiClient.createIntegrationApiKey).toHaveBeenCalledTimes(2)
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    expect(screen.queryByText('fixture-recovery-secret')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it.each(['escape', 'button'])('cancels revocation through %s without changing the list', async method => {
    listApiKeys.mockResolvedValueOnce([key])
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'settings.integrationApiKeys.revoke: Recovery notes' }))
    if (method === 'escape') fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    else fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'settings.integrationApiKeys.cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText(key.name)).toBeInTheDocument()
    expect(apiClient.revokeIntegrationApiKey).not.toHaveBeenCalled()
  })

  it('keeps a pending revocation open and permits cancellation after a failure', async () => {
    let reject!: (reason: unknown) => void
    listApiKeys.mockResolvedValueOnce([key])
    vi.mocked(apiClient.revokeIntegrationApiKey).mockReturnValueOnce(new Promise((_, fail) => { reject = fail }))
    render(<SettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'settings.integrationApiKeys.revoke: Recovery notes' }))
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationApiKeys.revokeConfirmCta' }))
    await waitFor(() => expect(apiClient.revokeIntegrationApiKey).toHaveBeenCalledTimes(1))
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'settings.integrationApiKeys.cancel' })).toBeDisabled()
    await act(async () => { reject('non-error rejection') })
    await screen.findByText('settings.integrationApiKeys.errorRevoking')
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText(key.name)).toBeInTheDocument()
  })
})
