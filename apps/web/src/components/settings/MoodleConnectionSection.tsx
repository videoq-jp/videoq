import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { API_URL } from '@/lib/apiConfig';
import { ConnectedAppCard, DisconnectAppDialog } from '@/components/auth/ConnectedAppCard';
import { MessageAlert } from '@/components/common/MessageAlert';
import { Heading, HeadingTitle } from '@/components/ui/heading';

type Connection = { id: string; moodleUrl: string; active: boolean };
const endpoint = API_URL.replace(/\/+$/, '') + '/lms/pairing';

export function MoodleConnectionSection({ embedded = false, headingLevel = 'h2', onConnectionCountChange }: { embedded?: boolean; headingLevel?: 'h2' | 'h3' | 'h4'; onConnectionCountChange?: (count: number) => void }) {
  const { t } = useTranslation();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<string | null>(null);
  const [disconnectPending, setDisconnectPending] = useState(false);
  const [disconnectError, setDisconnectError] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    const abort = new AbortController();
    async function load() {
      try {
        const response = await fetch(endpoint, { credentials: 'include', signal: abort.signal });
        if (!response.ok) return;
        const data = await response.json() as { connections: Connection[] };
        setConnections(data.connections.filter(connection => connection.active));
      } catch { /* Unconfigured deployments do not expose this optional section. */ }
    }
    void load();
    return () => abort.abort();
  }, []);
  useEffect(() => {
    onConnectionCountChange?.(connections?.length ?? 0);
  }, [connections, onConnectionCountChange]);
  useEffect(() => {
    if (disconnectError || disconnected) statusRef.current?.focus();
    else if (!disconnectTarget && wasConfirming.current) triggerRef.current?.focus();
    wasConfirming.current = disconnectTarget !== null;
  }, [disconnectTarget, disconnectError, disconnected]);
  if (connections === null) return null;
  async function disconnect(id: string) {
    setDisconnectPending(true); setDisconnectError(false); setDisconnected(false);
    try {
      const response = await fetch(endpoint + '/connections/' + encodeURIComponent(id) + '/disconnect', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!response.ok) throw new Error();
      setConnections(current => current?.filter(connection => connection.id !== id) ?? null);
      setDisconnected(true);
    } catch { setDisconnectError(true); }
    finally { setDisconnectPending(false); setDisconnectTarget(null); }
  }
  const target = connections.find(connection => connection.id === disconnectTarget);
  const setupGuide = <a className="text-key-900 underline underline-offset-4" href="https://github.com/videoq-jp/videoq-moodle#installation" target="_blank" rel="noopener noreferrer">{t('settings.moodle.setupGuide')}</a>;
  return (
    <section id="moodle" aria-label={embedded ? t('settings.moodle.title') : undefined} aria-labelledby={embedded ? undefined : 'moodle-heading'} className={embedded ? 'mb-3 scroll-mt-24' : 'scroll-mt-24 border-t border-solid-gray-200 pt-6'}>
      {!embedded && <Heading size="20" className="mb-2"><HeadingTitle id="moodle-heading" level={headingLevel}>{t('settings.moodle.title')}</HeadingTitle></Heading>}
      {!embedded && connections.length === 0 && <p className="mb-4 text-std-16N-170 text-solid-gray-600">{t('settings.moodle.description')}</p>}
      {(disconnectError || disconnected) && <div ref={statusRef} tabIndex={-1} className="mb-5 focus-visible:outline-4 focus-visible:outline-black focus-visible:outline-offset-2">
        <MessageAlert type={disconnectError ? 'error' : 'success'} message={t(disconnectError ? 'settings.connectedApps.errorRevoking' : 'settings.connectedApps.successRevoked')} />
      </div>}
      {connections.length > 0 && <ul aria-label={t('settings.moodle.title')} className="space-y-3">
        {connections.map(connection => <li key={connection.id} data-connection-id={connection.id}>
          <ConnectedAppCard
            name={t('settings.moodle.title')}
            subtitle={connection.moodleUrl}
            headingLevel={embedded ? headingLevel : 'h3'}
            disabled={disconnectPending}
            disconnecting={disconnectPending && disconnectTarget === connection.id}
            onDisconnect={(event) => {
              triggerRef.current = event.currentTarget;
              setDisconnectTarget(connection.id);
              setDisconnectError(false);
              setDisconnected(false);
            }}
          >
            {setupGuide}
          </ConnectedAppCard>
        </li>)}
      </ul>}
      {connections.length === 0 && <div className="text-std-16N-170">
        {!embedded && <p className="mb-3">{t('settings.moodle.empty')}</p>}
        {setupGuide}
      </div>}
      <DisconnectAppDialog
        open={target !== undefined}
        name={t('settings.moodle.title')}
        subtitle={target?.moodleUrl}
        description={t('settings.moodle.disconnectDescription')}
        pending={disconnectPending}
        onOpenChange={(open) => { if (!open) setDisconnectTarget(null); }}
        onConfirm={() => { if (target) void disconnect(target.id); }}
      />
    </section>
  );
}
