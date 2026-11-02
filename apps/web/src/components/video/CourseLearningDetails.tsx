import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CourseOverview, PanelTabs, type PanelTab } from './ViewerPanels';
import { CourseQaPanel } from './qa/CourseQaPanel';

export function CourseLearningDetails({ courseId, shareSlug, videoId, videoTitle, videoDescription, courseDescription, onVideoPlay }: {
  courseId: number; shareSlug?: string; videoId?: number; videoTitle?: string;
  videoDescription?: string; courseDescription?: string; onVideoPlay: (id: number, time: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [tab, setTab] = useState<PanelTab>('overview');
  return <div>
    <PanelTabs tabs={['overview', 'qa']} activeTab={tab} idPrefix={id} onChange={setTab} label={t('qa.tabsLabel')} />
    <div id={`${id}-panel-overview`} role="tabpanel" aria-labelledby={`${id}-tab-overview`} hidden={tab !== 'overview'} className="p-4 lg:p-6">
      {videoDescription || courseDescription ? <CourseOverview videoDescription={videoDescription} courseDescription={courseDescription} /> : <p className="text-solid-gray-600">{t('qa.noOverview')}</p>}
    </div>
    <div id={`${id}-panel-qa`} role="tabpanel" aria-labelledby={`${id}-tab-qa`} hidden={tab !== 'qa'} className="px-4 lg:px-6">
      <CourseQaPanel courseId={courseId} shareSlug={shareSlug} videoId={videoId} videoTitle={videoTitle} active={tab === 'qa'} onVideoPlay={onVideoPlay} />
    </div>
  </div>;
}
