import { useTranslation } from 'react-i18next';
import { BarChart3 } from 'lucide-react';

export function DashboardEmptyState() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center py-16 text-center text-solid-gray-700">
      <BarChart3 className="mb-4 h-12 w-12 text-solid-gray-300" />
      <h3 className="mb-1 text-std-18B-160 text-solid-gray-800">
        {t('dashboard.empty.title')}
      </h3>
      <p className="max-w-sm text-std-17N-170 text-solid-gray-600">
        {t('dashboard.empty.description')}
      </p>
    </div>
  );
}
