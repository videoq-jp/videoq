import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/digital-agency/cn';

interface AuthPageFooterProps {
  bordered?: boolean;
  align?: 'left' | 'center';
}

export function AuthPageFooter({ bordered = false, align = 'center' }: AuthPageFooterProps) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        bordered ? 'mt-16 border-t border-solid-gray-420 pt-6' : 'pt-6',
        align === 'left' ? 'text-left' : 'text-center',
      )}
    >
      <p className="text-oln-14N-100 text-solid-gray-600">
        {t('layout.authFooter', { year: new Date().getFullYear() })}
      </p>
    </div>
  );
}
