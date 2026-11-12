import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Heading, HeadingTitle } from '@/components/ui/heading';
import {
  StepNavigation,
  StepNavigationDescription,
  StepNavigationList,
  StepNavigationNumber,
  StepNavigationStateIndicator,
  StepNavigationStep,
  StepNavigationStepHeader,
  StepNavigationTitle,
} from '@/components/ui/step-navigation';

type StepKey = 'upload' | 'transcribe' | 'ask' | 'course';
// Questions are asked from a course's chat, so the course comes before asking.
const STEP_ORDER: StepKey[] = ['upload', 'transcribe', 'course', 'ask'];

export interface GettingStartedProgress {
  hasVideos: boolean;
  hasProcessingVideos: boolean;
  hasCompletedVideos: boolean;
  /** The user owns a course (joined courses do not count). */
  hasCourse: boolean;
  hasCourseVideos: boolean;
  hasAskedQuestion: boolean;
}

interface GettingStartedGuideProps {
  userId: string;
  progress: GettingStartedProgress;
  /** The user's own course, once there is one. */
  courseHref: string | null;
  onUpload: () => void;
}

const dismissedKey = (userId: string) => `videoq:getting-started-dismissed:${userId}`;

function readDismissed(userId: string): boolean {
  try {
    return window.localStorage.getItem(dismissedKey(userId)) === '1';
  } catch {
    return false;
  }
}

export function GettingStartedGuide({ userId, progress, courseHref, onUpload }: GettingStartedGuideProps) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(() => readDismissed(userId));

  const done: Record<StepKey, boolean> = {
    upload: progress.hasVideos,
    transcribe: progress.hasCompletedVideos,
    course: progress.hasCourse && progress.hasCourseVideos,
    ask: progress.hasAskedQuestion,
  };
  const currentKey = STEP_ORDER.find((key) => !done[key]);

  if (dismissed || !currentKey) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(dismissedKey(userId), '1');
    } catch {
      // Storage can be unavailable (private mode); hiding for this visit is enough.
    }
    setDismissed(true);
  };

  // Transcription runs on its own, so while it is underway there is nothing to click.
  const isWaiting = currentKey === 'transcribe' && progress.hasProcessingVideos;

  const renderAction = (key: StepKey) => {
    switch (key) {
      case 'upload':
        return (
          <Button type="button" variant="solid" size="md" onClick={onUpload}>
            {t('home.gettingStarted.steps.upload.action')}
          </Button>
        );
      case 'transcribe':
        return (
          <Button asChild variant="outline" size="md">
            <Link href="/videos">{t('home.gettingStarted.steps.transcribe.action')}</Link>
          </Button>
        );
      case 'course':
        // An empty course already exists: send the user there to add videos.
        return (
          <Button asChild variant="solid" size="md">
            <Link href={courseHref ?? '/videos/courses'}>
              {t(courseHref ? 'home.gettingStarted.steps.course.addVideosAction' : 'home.gettingStarted.steps.course.action')}
            </Link>
          </Button>
        );
      case 'ask':
        return (
          <Button asChild variant="solid" size="md">
            <Link href={courseHref ?? '/videos/courses'}>{t('home.gettingStarted.steps.ask.action')}</Link>
          </Button>
        );
    }
  };

  return (
    <section aria-labelledby="getting-started-title" className="mb-12">
      <div className="mb-6 flex items-end justify-between gap-4">
        <Heading size="32" className="text-std-24B-150 md:text-std-32B-150">
          <HeadingTitle level="h2" id="getting-started-title">{t('home.gettingStarted.title')}</HeadingTitle>
        </Heading>
        <Button type="button" variant="text" size="sm" onClick={dismiss}>
          {t('home.gettingStarted.dismiss')}
        </Button>
      </div>

      <StepNavigation orientation="vertical" className="pt-6">
        <StepNavigationList>
          {STEP_ORDER.map((key, index) => {
            const state = done[key] ? 'completed' : undefined;
            const isCurrent = key === currentKey;
            return (
              <StepNavigationStep
                key={key}
                state={state}
                first={index === 0}
                last={index === STEP_ORDER.length - 1}
                aria-current={isCurrent ? 'step' : undefined}
              >
                <StepNavigationStepHeader srLabel={t('home.gettingStarted.stepLabel')}>
                  <StepNavigationNumber>
                    {index + 1}
                    <StepNavigationStateIndicator
                      state={state}
                      completedLabel={t('home.gettingStarted.completed')}
                    />
                  </StepNavigationNumber>
                  <StepNavigationTitle>{t(`home.gettingStarted.steps.${key}.title`)}</StepNavigationTitle>
                </StepNavigationStepHeader>
                <StepNavigationDescription className="text-solid-gray-700">
                  {t(`home.gettingStarted.steps.${key}.description`)}
                </StepNavigationDescription>
                {isCurrent ? (
                  <div className="mt-4 pl-[calc(var(--step-number-size)+var(--step-number-margin)*2+1rem)]">
                    {isWaiting ? (
                      <p role="status" className="text-std-17B-170 text-solid-gray-800">
                        {t('home.gettingStarted.processing')}
                      </p>
                    ) : (
                      renderAction(key)
                    )}
                  </div>
                ) : null}
              </StepNavigationStep>
            );
          })}
        </StepNavigationList>
      </StepNavigation>
    </section>
  );
}
