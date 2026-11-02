import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlignLeft, List, Sparkles, MessageCircle } from 'lucide-react';

export type PanelTab = 'videos' | 'assistant' | 'overview' | 'qa';

const PANEL_TAB_ICONS: Record<PanelTab, typeof List> = { videos: List, assistant: Sparkles, overview: AlignLeft, qa: MessageCircle };

export function PanelTabs({ tabs, activeTab, idPrefix, onChange, label }: {
  label?: string;
  tabs: PanelTab[];
  activeTab: PanelTab;
  idPrefix: string;
  onChange: (tab: PanelTab) => void;
}) {
  const { t } = useTranslation();

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = tabs.indexOf(activeTab);
    const next = {
      ArrowRight: tabs[(index + 1) % tabs.length],
      ArrowLeft: tabs[(index - 1 + tabs.length) % tabs.length],
      Home: tabs[0],
      End: tabs[tabs.length - 1],
    }[event.key];
    if (!next) return;
    event.preventDefault();
    onChange(next);
    document.getElementById(`${idPrefix}-tab-${next}`)?.focus();
  };

  return (
    <div role="tablist" aria-label={label ?? t('videos.shared.tabs.label')} className="flex shrink-0 gap-1 overflow-x-auto border-b border-solid-gray-420 px-2">
      {tabs.map((tab) => {
        const Icon = PANEL_TAB_ICONS[tab];
        const isActive = tab === activeTab;
        return (
          <button
            key={tab}
            id={`${idPrefix}-tab-${tab}`}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={`${idPrefix}-panel-${tab}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(tab)}
            onKeyDown={handleKeyDown}
            className={`flex min-h-12 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-oln-16N-100 transition-colors focus-visible:outline-4 focus-visible:-outline-offset-4 focus-visible:outline-black ${
              isActive ? 'border-key-900 font-bold text-solid-gray-800' : 'border-transparent text-solid-gray-600 hover:text-solid-gray-800'
            }`}
          >
            <Icon className={`h-4 w-4 shrink-0 ${isActive ? 'text-key-900' : ''}`} aria-hidden="true" />
            {t(`videos.shared.tabs.${tab}`)}
          </button>
        );
      })}
    </div>
  );
}

export function CourseOverview({ videoDescription, courseDescription }: { videoDescription?: string; courseDescription?: string }) {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      {videoDescription ? (
        <section className="space-y-2">
          <h3 className="text-std-16B-170 text-solid-gray-800">{t('videos.shared.overview')}</h3>
          <p className="whitespace-pre-wrap break-words text-std-16N-170 text-solid-gray-700">{videoDescription}</p>
        </section>
      ) : null}
      {courseDescription ? (
        <section className="space-y-2">
          <h3 className="text-std-16B-170 text-solid-gray-800">{t('videos.shared.aboutCourse')}</h3>
          <p className="whitespace-pre-wrap break-words text-std-16N-170 text-solid-gray-700">{courseDescription}</p>
        </section>
      ) : null}
    </div>
  );
}

