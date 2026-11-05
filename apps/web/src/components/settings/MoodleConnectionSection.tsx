import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { API_URL } from '@/lib/apiConfig';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Heading, HeadingTitle } from '@/components/ui/heading';

type Connection = { id: string; moodleUrl: string; active: boolean };
type Pairing = { code: string; moodleUrl: string; expiresAt: string };
const endpoint = API_URL.replace(/\/+$/, '') + '/lms/pairing';

export function MoodleConnectionSection() {
  const { t } = useTranslation();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [moodleUrl, setMoodleUrl] = useState('');
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expired, setExpired] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<string | null>(null);
  const [disconnectPending, setDisconnectPending] = useState(false);
  const [disconnectError, setDisconnectError] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    async function load() {
      try {
        const response = await fetch(endpoint, { credentials: 'include', signal: abort.signal });
        if (!response.ok) return;
        const data = await response.json() as { connections: Connection[] };
        setConnections(data.connections);
      } catch { /* Unconfigured deployments do not expose this optional section. */ }
    }
    void load();
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (!pairing) return;
    const timeout = window.setTimeout(() => { setExpired(true); setPairing(null); }, Math.max(0, Date.parse(pairing.expiresAt) - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [pairing]);
  if (connections === null) return null;
  async function issue(event: React.FormEvent) {
    event.preventDefault(); setPending(true); setError(false); setCopied(false); setPairing(null); setExpired(false);
    try {
      const response = await fetch(endpoint, { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ moodleUrl: moodleUrl.trim() }) });
      if (!response.ok) throw new Error();
      setPairing(await response.json() as Pairing);
    } catch { setError(true); } finally { setPending(false); }
  }
  async function disconnect(id: string) {
    setDisconnectPending(true); setDisconnectError(false); setDisconnected(false);
    try {
      const response = await fetch(endpoint + '/connections/' + encodeURIComponent(id) + '/disconnect', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!response.ok) throw new Error();
      setConnections(current => current?.map(connection => connection.id === id ? { ...connection, active: false } : connection) ?? null);
      setDisconnectTarget(null); setPairing(null); setDisconnected(true);
    } catch { setDisconnectError(true); } finally { setDisconnectPending(false); }
  }
  return <section id="moodle" aria-labelledby="moodle-heading" className="scroll-mt-24 border-t border-solid-gray-200 pt-6">
    <Heading size="20" hasChip className="mb-2"><HeadingTitle id="moodle-heading" level="h2">{t('settings.moodle.title')}</HeadingTitle></Heading>
    <p className="mb-4 text-std-16N-170 text-solid-gray-600">{t('settings.moodle.description')}</p>
    {connections.length > 0 && <ul className="mb-4 list-disc pl-6">{connections.map(connection => <li key={connection.id} className="mb-3" data-connection-id={connection.id}>
      <span>{connection.moodleUrl} — {t(connection.active ? 'settings.moodle.connected' : 'settings.moodle.disabled')}</span>
      {connection.active && <Button variant="text" className="ml-3" disabled={disconnectPending} onClick={() => { setDisconnectTarget(connection.id); setDisconnectError(false); }}>{t('settings.moodle.disconnect')}</Button>}
      {disconnectTarget === connection.id && <div className="mt-2 max-w-2xl rounded-8 bg-solid-gray-50 p-4">
        <p className="mb-3">{t('settings.moodle.disconnectDescription')}</p>
        <div className="flex flex-wrap gap-3">
          <Button disabled={disconnectPending} onClick={() => void disconnect(connection.id)}>{t(disconnectPending ? 'settings.moodle.disconnecting' : 'settings.moodle.confirmDisconnect')}</Button>
          <Button variant="outline" disabled={disconnectPending} onClick={() => { setDisconnectTarget(null); setDisconnectError(false); }}>{t('settings.moodle.cancelDisconnect')}</Button>
        </div>
      </div>}
    </li>)}</ul>}
    {disconnectError && <p role="alert" className="mb-3 text-error-1">{t('settings.moodle.disconnectError')}</p>}
    {disconnected && <p role="status" className="mb-3">{t('settings.moodle.disconnected')}</p>}
    <form onSubmit={event => void issue(event)} className="flex max-w-2xl flex-col gap-3">
      <Label htmlFor="moodle-url">{t('settings.moodle.url')}</Label>
      <Input id="moodle-url" type="url" required value={moodleUrl} onChange={event => setMoodleUrl(event.target.value)} aria-describedby="moodle-url-help" />
      <p id="moodle-url-help" className="text-solid-gray-600">{t('settings.moodle.urlHelp')}</p>
      <Button type="submit" disabled={pending || !moodleUrl.trim()} className="self-start">{t(pending ? 'settings.moodle.issuing' : 'settings.moodle.issue')}</Button>
    </form>
    {error && <p role="alert" className="mt-3 text-error-1">{t('settings.moodle.error')}</p>}
    {expired && <p role="status" className="mt-3">{t('settings.moodle.expired')}</p>}
    {pairing && <div className="mt-4 flex max-w-2xl flex-col gap-3 rounded-8 bg-solid-gray-50 p-4">
      <Label htmlFor="moodle-code">{t('settings.moodle.code')}</Label>
      <textarea id="moodle-code" readOnly value={pairing.code} rows={4} className="w-full break-all rounded border border-solid-gray-600 p-3" />
      <Button variant="outline" className="self-start" onClick={() => { void navigator.clipboard.writeText(pairing.code).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{t(copied ? 'settings.moodle.copied' : 'settings.moodle.copy')}</Button>
      <p>{t('settings.moodle.instructions')}</p>
      <a className="text-key-900 underline" href={pairing.moodleUrl + '/local/videoq/connect.php'} target="_blank" rel="noopener noreferrer">{t('settings.moodle.openMoodle')}</a>
    </div>}
  </section>;
}
