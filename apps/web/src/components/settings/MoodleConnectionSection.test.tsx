import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MoodleConnectionSection } from './MoodleConnectionSection';

const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it('does not display a setup form when Moodle integration is disabled', async () => {
  fetchMock.mockResolvedValue(response({}, 404));
  const { container } = render(<MoodleConnectionSection />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(container).toBeEmptyDOMElement();
});
it('directs new connections to Moodle without a VideoQ setup form or code request', async () => {
  fetchMock.mockResolvedValue(response({ connections: [] }));
  render(<MoodleConnectionSection />);
  expect(await screen.findByText('settings.moodle.empty')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'settings.moodle.setupGuide' })).toHaveAttribute('href', 'https://github.com/videoq-jp/videoq-moodle#installation');
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('method');
});

it('removes a disconnected connection from the list and shows the empty state', async () => {
  fetchMock.mockResolvedValueOnce(response({ connections: [{ id: 'school', moodleUrl: 'https://moodle.example', active: true }] }))
    .mockResolvedValueOnce(response({ disconnected: true }));
  render(<MoodleConnectionSection />);
  fireEvent.click(await screen.findByRole('button', { name: /^settings.connectedApps.revoke:/ }));
  expect(screen.getByText('settings.moodle.disconnectDescription')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'settings.cancel' }));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: /^settings.connectedApps.revoke:/ }));
  fireEvent.click(screen.getByRole('button', { name: 'settings.connectedApps.revoke' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('settings.connectedApps.successRevoked');
  expect(screen.queryByText(/https:\/\/moodle.example/)).not.toBeInTheDocument();
  expect(screen.getByText('settings.moodle.empty')).toBeInTheDocument();
  expect(fetchMock.mock.calls[1]).toEqual([expect.stringContaining('/connections/school/disconnect'), expect.objectContaining({ method: 'POST', credentials: 'include' })]);
  expect(screen.queryByRole('button', { name: /^settings.connectedApps.revoke:/ })).not.toBeInTheDocument();
});
it('keeps a connection active in the UI if revocation fails', async () => {
  fetchMock.mockResolvedValueOnce(response({ connections: [{ id: 'school', moodleUrl: 'https://moodle.example', active: true }] }))
    .mockResolvedValueOnce(response({}, 500));
  render(<MoodleConnectionSection />);
  fireEvent.click(await screen.findByRole('button', { name: /^settings.connectedApps.revoke:/ }));
  fireEvent.click(screen.getByRole('button', { name: 'settings.connectedApps.revoke' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('settings.connectedApps.errorRevoking');
  expect(screen.getByRole('button', { name: /^settings.connectedApps.revoke:/ })).toBeEnabled();
  expect(screen.queryByText('settings.connectedApps.successRevoked')).not.toBeInTheDocument();
});

it('omits disconnected connections returned by an older API', async () => {
  fetchMock.mockResolvedValue(response({ connections: [
    { id: 'current', moodleUrl: 'https://current.example', active: true },
    { id: 'old', moodleUrl: 'https://old.example', active: false },
  ] }));
  render(<MoodleConnectionSection />);
  expect(await screen.findByText(/https:\/\/current.example/)).toBeInTheDocument();
  expect(screen.queryByText(/https:\/\/old.example/)).not.toBeInTheDocument();
});
