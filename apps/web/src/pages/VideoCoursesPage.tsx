import { useMemo, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTranslation } from 'react-i18next';
import type { CourseListItem } from '@videoq/trpc';
import { Link, useI18nNavigate } from '@/lib/i18n';
import { AppPageHeader } from '@/components/layout/AppPageHeader';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ErrorMessage } from '@/components/auth/ErrorMessage';
import { useVideoCourses } from '@/hooks/useVideoCourses';
import {
  useCreateVideoCourseMutation,
  useReorderVideoCoursesMutation,
} from '@/hooks/useVideoCoursesPageData';
import { VideoCourseCreateModal } from '@/components/video/VideoCourseCreateModal';
import { Button } from '@/components/ui/button';
import { UtilityLink } from '@/components/ui/utility-link';
import { ChipLabel } from '@/components/ui/chip-label';
import { Heading, HeadingTitle } from '@/components/ui/heading';
import { List } from '@/components/ui/list';
import { MenuList, MenuListItem } from '@/components/ui/menu-list';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  GripVertical,
  Plus,
} from 'lucide-react';

interface SortableCourseRowProps {
  course: CourseListItem;
  isFirst: boolean;
  isLast: boolean;
  canReorder: boolean;
  isSortingDisabled: boolean;
  onOpen: (courseId: number) => void;
  onMove: (courseId: number, direction: 'up' | 'down') => void;
}

function SortableCourseRow({
  course,
  isFirst,
  isLast,
  canReorder,
  isSortingDisabled,
  onOpen,
  onMove,
}: SortableCourseRowProps) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: course.id,
    disabled: isSortingDisabled,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <MenuListItem
      ref={setNodeRef}
      style={style}
      className={`border-b border-solid-gray-200 ${isDragging ? 'z-50 bg-white' : ''}`}
    >
      <div className="flex w-full items-start gap-2 px-2 py-3 md:items-center md:gap-3 md:px-4">
        {canReorder && (
          <span
            {...attributes}
            {...listeners}
            onClick={(event) => event.stopPropagation()}
            className={`mt-1 shrink-0 text-solid-gray-420 md:mt-0 ${isSortingDisabled ? 'cursor-wait opacity-50' : 'cursor-grab active:cursor-grabbing'}`}
            aria-label={t('videos.courses.dragHandle')}
          >
            <GripVertical className="h-5 w-5" />
          </span>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-2 md:flex-row md:items-center md:gap-3">
          <button
            type="button"
            onClick={() => onOpen(course.id)}
            className="min-w-0 flex-1 text-left focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-black focus-visible:bg-yellow-300"
          >
            <span className="block truncate text-std-16B-170 text-solid-gray-800 hover:underline">
              {course.name}
            </span>
            <span className="mt-1 block truncate text-std-16N-170 text-solid-gray-600">
              {course.description || t('common.messages.noDescription')}
            </span>
          </button>

          <div className="flex flex-wrap items-center gap-2">
            <ChipLabel variant="filled-1" color="blue" className="min-h-0 shrink-0 text-oln-14N-100">
              {t('videos.courses.videoCount', { count: course.video_count })}
            </ChipLabel>
            {course.access_role === 'member' ? (
              <ChipLabel variant="filled-1" color="gray" className="min-h-0 shrink-0 text-oln-14N-100">
                {t('videos.courses.memberBadge')}
              </ChipLabel>
            ) : null}

            <div className="ml-auto flex shrink-0 items-center gap-1 md:ml-0">
              {canReorder && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={(event) => {
                      event.stopPropagation();
                      onMove(course.id, 'up');
                    }}
                    disabled={isFirst || isSortingDisabled}
                    aria-label={t('videos.courses.moveUp', { name: course.name })}
                    className="min-w-0 w-8 px-0"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={(event) => {
                      event.stopPropagation();
                      onMove(course.id, 'down');
                    }}
                    disabled={isLast || isSortingDisabled}
                    aria-label={t('videos.courses.moveDown', { name: course.name })}
                    className="min-w-0 w-8 px-0"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </>
              )}
              <Button
                type="button"
                variant="solid"
                size="xs"
                onClick={() => onOpen(course.id)}
                aria-label={t('videos.courses.open', { name: course.name })}
                className="min-w-0 w-8 px-0"
              >
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </MenuListItem>
  );
}

export default function VideoCoursesPage() {
  const navigate = useI18nNavigate();
  const {
    courses,
    isLoading,
    error: loadError,
    isFetchingNextPage,
    isFetching,
    retry,
    sentinelRef,
  } = useVideoCourses();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [orderedCourseIds, setOrderedCourseIds] = useState<number[] | null>(null);
  const { t } = useTranslation();

  const createCourseMutation = useCreateVideoCourseMutation();
  const reorderCoursesMutation = useReorderVideoCoursesMutation();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleCreate = async (name: string, description: string) => {
    await createCourseMutation.mutateAsync({ name, description });
  };

  const { ownedCourses, joinedCourses } = useMemo(() => ({
    ownedCourses: courses.filter((course) => course.access_role !== 'member'),
    joinedCourses: courses.filter((course) => course.access_role === 'member'),
  }), [courses]);
  const visibleCourses = useMemo(() => {
    if (!orderedCourseIds) return ownedCourses;
    const coursesById = new Map(ownedCourses.map((course) => [course.id, course]));
    const ordered = orderedCourseIds
      .map((id) => coursesById.get(id))
      .filter((course): course is CourseListItem => Boolean(course));
    const included = new Set(ordered.map((course) => course.id));
    return [...ordered, ...ownedCourses.filter((course) => !included.has(course.id))];
  }, [orderedCourseIds, ownedCourses]);
  const reorderError = reorderCoursesMutation.error instanceof Error
    ? reorderCoursesMutation.error.message
    : null;
  const canReorder = visibleCourses.length > 1;
  const isSortingDisabled = !canReorder || reorderCoursesMutation.isPending;

  const applyCourseOrder = (nextCourses: CourseListItem[]) => {
    const previousIds = orderedCourseIds;
    const nextIds = nextCourses.map((course) => course.id);
    setOrderedCourseIds(nextIds);
    reorderCoursesMutation.mutate(
      { courseIds: nextIds },
      {
        onSuccess: () => setOrderedCourseIds(null),
        onError: () => setOrderedCourseIds(previousIds),
      },
    );
  };

  const handleMoveCourse = (courseId: number, direction: 'up' | 'down') => {
    if (isSortingDisabled) return;
    const oldIndex = visibleCourses.findIndex((course) => course.id === courseId);
    if (oldIndex === -1) return;
    const newIndex = direction === 'up' ? oldIndex - 1 : oldIndex + 1;
    if (newIndex < 0 || newIndex >= visibleCourses.length) return;
    applyCourseOrder(arrayMove(visibleCourses, oldIndex, newIndex));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    if (isSortingDisabled) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = visibleCourses.findIndex((course) => course.id === active.id);
    const newIndex = visibleCourses.findIndex((course) => course.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    applyCourseOrder(arrayMove(visibleCourses, oldIndex, newIndex));
  };

  return (
    <>
      <AppPageHeader
        title={t('videos.courses.title')}
        description={t('videos.courses.subtitle')}
        action={(
          <Button
            type="button"
            variant="solid"
            size="md"
            onClick={() => setIsModalOpen(true)}
            className="shrink-0"
          >
            <Plus className="w-4 h-4 mr-2" />
            {t('videos.courses.create')}
          </Button>
        )}
      />

      <div className="w-full">
        {(loadError || reorderError) && (
          <div className="mb-6">
            <ErrorMessage message={loadError || reorderError} />
            {loadError && (
              <Button type="button" variant="outline" size="sm" onClick={() => { void retry(); }} disabled={isFetching} aria-busy={isFetching} className="mt-3">
                {t('videos.courses.retryLoad')}
              </Button>
            )}
          </div>
        )}

        {isLoading ? (
          <div className="flex justify-center py-24">
            <LoadingSpinner />
          </div>
        ) : courses.length === 0 ? !loadError && (
          <div className="flex flex-col items-start justify-center border-t border-solid-gray-420 py-12">
            <Heading size="20" hasChip className="mb-2">
              <HeadingTitle level="h2">{t('videos.courses.empty')}</HeadingTitle>
            </Heading>
            <p className="max-w-2xl text-std-16N-170 text-solid-gray-700">
              {t('videos.courses.emptyDescription')}
            </p>
            <List spacing="4" className="mt-3 text-std-16N-170 text-solid-gray-800">
              {(t('videos.courses.emptyBenefits.bullets', { returnObjects: true }) as string[]).map((benefit) => (
                <li key={benefit}>{benefit}</li>
              ))}
            </List>
            <p className="mt-6 mb-4 text-std-16N-170 text-solid-gray-700">
              {t('videos.courses.emptyNeedsVideos')}
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <Button
                type="button"
                variant="solid"
                size="md"
                onClick={() => setIsModalOpen(true)}
              >
                <Plus className="w-4 h-4 mr-2" />
                {t('videos.courses.create')}
              </Button>
              <UtilityLink asChild>
                <Link href="/videos">{t('videos.goToLibrary')}</Link>
              </UtilityLink>
            </div>
          </div>
        ) : (
          <>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              {visibleCourses.length > 0 ? (
                <SortableContext
                  items={visibleCourses.map((course) => course.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <MenuList className="border-t border-solid-gray-420">
                    {visibleCourses.map((course, index) => (
                      <SortableCourseRow
                        key={course.id}
                        course={course}
                        isFirst={index === 0}
                        isLast={index === visibleCourses.length - 1}
                        canReorder={canReorder}
                        isSortingDisabled={isSortingDisabled}
                        onOpen={(courseId) => navigate(`/videos/courses/${courseId}`)}
                        onMove={handleMoveCourse}
                      />
                    ))}
                  </MenuList>
                </SortableContext>
              ) : null}

              {joinedCourses.length > 0 ? (
                <section className={visibleCourses.length > 0 ? 'mt-10' : ''}>
                  <Heading size="20" className="mb-3">
                    <HeadingTitle level="h2">{t('videos.courses.joinedTitle')}</HeadingTitle>
                  </Heading>
                  <SortableContext
                    items={joinedCourses.map((course) => course.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <MenuList className="border-t border-solid-gray-420">
                      {joinedCourses.map((course, index) => (
                        <SortableCourseRow
                          key={course.id}
                          course={course}
                          isFirst={index === 0}
                          isLast={index === joinedCourses.length - 1}
                          canReorder={false}
                          isSortingDisabled
                          onOpen={(courseId) => navigate(`/videos/courses/${courseId}`)}
                          onMove={handleMoveCourse}
                        />
                      ))}
                    </MenuList>
                  </SortableContext>
                </section>
              ) : null}
            </DndContext>

            <div ref={sentinelRef} data-testid="courses-infinite-scroll-sentinel" />

            {isFetchingNextPage && (
              <div className="flex justify-center mt-4">
                <span className="text-std-16N-170 text-solid-gray-600">{t('videos.courses.loadingMore')}</span>
              </div>
            )}
          </>
        )}
      </div>

      <VideoCourseCreateModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onCreate={handleCreate}
      />
    </>
  );
}
