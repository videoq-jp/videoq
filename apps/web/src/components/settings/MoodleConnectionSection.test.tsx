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
it('issues a code for the typed Moodle URL and points to its administrator setup page', async () => {
  fetchMock.mockResolvedValueOnce(response({ connections: [] })).mockResolvedValueOnce(response({ code: 'VIDEOQ1.secret',
    moodleUrl: 'https://moodle.example/campus', expiresAt: new Date(Date.now() + 600000).toISOString() }));
  render(<MoodleConnectionSection />);
  fireEvent.change(await screen.findByLabelText('settings.moodle.url'), { target: { value: 'https://moodle.example/campus' } });
  fireEvent.click(screen.getByRole('button', { name: 'settings.moodle.issue' }));
  expect(await screen.findByLabelText('settings.moodle.code')).toHaveValue('VIDEOQ1.secret');
  expect(screen.getByRole('link', { name: 'settings.moodle.openMoodle' })).toHaveAttribute('href', 'https://moodle.example/campus/local/videoq/connect.php');
  expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', credentials: 'include', body: JSON.stringify({ moodleUrl: 'https://moodle.example/campus' }) });
});
it('removes the previous code when generating a new code fails', async () => {
  fetchMock.mockResolvedValueOnce(response({ connections: [] })).mockResolvedValueOnce(response({ code: 'VIDEOQ1.previous',
    moodleUrl: 'https://moodle.example', expiresAt: new Date(Date.now() + 600000).toISOString() })).mockResolvedValueOnce(response({}, 500));
  render(<MoodleConnectionSection />);
  fireEvent.change(await screen.findByLabelText('settings.moodle.url'), { target: { value: 'https://moodle.example' } });
  fireEvent.click(screen.getByRole('button', { name: 'settings.moodle.issue' }));
  await screen.findByLabelText('settings.moodle.code');
  fireEvent.click(screen.getByRole('button', { name: 'settings.moodle.issue' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('settings.moodle.error');
  expect(screen.queryByLabelText('settings.moodle.code')).not.toBeInTheDocument();
});

it('confirms disconnection, retains the list entry and shows its revoked state', async () => {
  fetchMock.mockResolvedValueOnce(response({ connections: [{ id: 'school', moodleUrl: 'https://moodle.example', active: true }] }))
    .mockResolvedValueOnce(response({ disconnected: true }));
  render(<MoodleConnectionSection />);
  fireEvent.click(await screen.findByRole('button', { name: 'settings.moodle.disconnect' }));
  expect(screen.getByText('settings.moodle.disconnectDescription')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'settings.moodle.cancelDisconnect' }));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'settings.moodle.disconnect' }));
  fireEvent.click(screen.getByRole('button', { name: 'settings.moodle.confirmDisconnect' }));
  expect(await screen.findByRole('status')).toHaveTextContent('settings.moodle.disconnected');
  expect(screen.getByText(/https:\/\/moodle.example — settings.moodle.disabled/)).toBeInTheDocument();
  expect(fetchMock.mock.calls[1]).toEqual([expect.stringContaining('/connections/school/disconnect'), expect.objectContaining({ method: 'POST', credentials: 'include' })]);
  expect(screen.queryByRole('button', { name: 'settings.moodle.disconnect' })).not.toBeInTheDocument();
});
it('keeps a connection active in the UI if revocation fails', async () => {
  fetchMock.mockResolvedValueOnce(response({ connections: [{ id: 'school', moodleUrl: 'https://moodle.example', active: true }] }))
    .mockResolvedValueOnce(response({}, 500));
  render(<MoodleConnectionSection />);
  fireEvent.click(await screen.findByRole('button', { name: 'settings.moodle.disconnect' }));
  fireEvent.click(screen.getByRole('button', { name: 'settings.moodle.confirmDisconnect' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('settings.moodle.disconnectError');
  expect(screen.getByRole('button', { name: 'settings.moodle.disconnect' })).toBeEnabled();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
