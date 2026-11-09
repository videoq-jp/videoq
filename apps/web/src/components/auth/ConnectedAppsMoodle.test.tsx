import { fireEvent, render, screen, within } from '@testing-library/react';
import { ConnectedAppsSection } from './ConnectedAppsSection';

const fetchMock = vi.fn();
const response = (connections: unknown[]) => new Response(JSON.stringify({ connections }));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  globalThis.__setTrpcHandler('account.connectedApps', async () => []);
});
afterEach(() => vi.unstubAllGlobals());

it('groups Moodle under connected apps and restores the empty state after disconnection', async () => {
  fetchMock.mockResolvedValueOnce(response([{ id: 'school', moodleUrl: 'https://school.example', active: true }]))
    .mockResolvedValueOnce(new Response('{}'));
  render(<ConnectedAppsSection headingLevel="h3" />);
  const apps = within(screen.getByRole('region', { name: 'settings.connectedApps.title' }));
  expect(await apps.findByText('https://school.example', { exact: false })).toBeInTheDocument();
  expect(apps.getByRole('heading', { name: 'settings.moodle.title', level: 4 })).toBeInTheDocument();
  expect(apps.queryByText('settings.connectedApps.empty')).not.toBeInTheDocument();
  expect(apps.queryByText('settings.moodle.empty')).not.toBeInTheDocument();
  fireEvent.click(apps.getByRole('button', { name: 'settings.moodle.disconnect' }));
  fireEvent.click(apps.getByRole('button', { name: 'settings.moodle.confirmDisconnect' }));
  expect(await apps.findByText('settings.connectedApps.empty')).toBeInTheDocument();
  expect(apps.queryByText('https://school.example', { exact: false })).not.toBeInTheDocument();
});
