import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthPageIntro } from '@/components/layout/AuthPageIntro';
import { ErrorMessage } from '@/components/auth/ErrorMessage';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';

/**
 * OAuth consent page for Better Auth oauth-provider.
 * Completes authorization via authClient.oauth2.consent (JSON + oauth_query).
 */
export default function ConsentPage() {
  const { t } = useTranslation();
  const params = new URLSearchParams(window.location.search);
  const clientName = params.get('client_name') || params.get('client_id') || 'Application';
  const requestedScopes = new Set((params.get('scope') ?? '').split(/\s+/).filter(Boolean));
  const canReadVideoq = requestedScopes.has('videoq.read');
  const canWriteVideoq = requestedScopes.has('videoq.write');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function decide(accept: boolean) {
    setLoading(true);
    setError(null);
    try {
      const { data, error: consentError } = await authClient.oauth2.consent({ accept });
      if (consentError) {
        throw new Error(consentError.message || 'Consent failed');
      }
      const redirectUrl =
        data && typeof data === 'object' && 'url' in data && typeof data.url === 'string'
          ? data.url
          : null;
      if (redirectUrl) {
        window.location.href = redirectUrl;
        return;
      }
      throw new Error('Consent completed without redirect');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Consent failed');
      setLoading(false);
    }
  }

  return (
    <>
      <AuthPageIntro
        badge="OAuth"
        title={t('auth.consent.title', { defaultValue: 'Authorize application' })}
      />
      <p className="mb-6 text-std-17N-170 text-solid-gray-600">
        {t('auth.consent.body', {
          defaultValue: '{{name}} is requesting access to your VideoQ account.',
          name: clientName,
        })}
      </p>
      {(canReadVideoq || canWriteVideoq) && (
        <div className="mb-6 rounded-lg border border-solid-gray-300 bg-solid-gray-50 p-4 text-std-17N-170 text-solid-gray-700">
          <p className="mb-2 font-bold">
            {t('auth.consent.permissions', { defaultValue: 'Requested permissions' })}
          </p>
          <ul className="list-disc space-y-1 pl-5">
            {canReadVideoq && (
              <li>
                {t('auth.consent.readPermission', {
                  defaultValue: 'View your videos, courses, chat history, and analytics',
                })}
              </li>
            )}
            {canWriteVideoq && (
              <li>
                {t('auth.consent.writePermission', {
                  defaultValue: 'Upload or register videos and create or update course membership',
                })}
              </li>
            )}
          </ul>
        </div>
      )}
      {error && (
        <div className="mb-4">
          <ErrorMessage message={error} />
        </div>
      )}
      <div className="flex flex-col gap-3">
        <Button
          type="button"
          variant="solid"
          size="lg"
          disabled={loading}
          onClick={() => void decide(true)}
        >
          {t('auth.consent.accept', { defaultValue: 'Allow' })}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={loading}
          onClick={() => void decide(false)}
        >
          {t('auth.consent.deny', { defaultValue: 'Deny' })}
        </Button>
      </div>
    </>
  );
}
