import { useTranslation } from 'react-i18next';

/** Explain the same sharing contract before publishing, joining, or chatting. */
export function CourseSharingNotice({ method }: { method: 'link' | 'invitation' }) {
  const { t } = useTranslation();

  return (
    <div className="shrink-0 space-y-2 text-std-16N-170 text-solid-gray-700">
      <p>{t(`courseSharing.${method}`)}</p>
      <p>{t('courseSharing.quotaAndHistory')}</p>
    </div>
  );
}
