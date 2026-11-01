import { features } from "@/lib/deployment";
import { useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
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
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  ArrowLeft,
  List,
  Pencil,
  Play,
  Plus,
  Save,
  Share2,
  Trash2,
  Users,
  LogOut,
  X,
} from 'lucide-react';
import { apiClient, type VideoCourse, type VideoInCourse } from '@/lib/api';
import { buildYoutubeEmbedSrc } from '@/lib/video/embed';
import { Link } from '@/lib/i18n';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { DashboardButton } from '@/components/dashboard/DashboardButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { ErrorMessage } from '@/components/auth/ErrorMessage';
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  Breadcrumbs,
  BreadcrumbsLabel,
} from '@/components/ui/breadcrumbs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ChipLabel } from '@/components/ui/chip-label';
import { Heading, HeadingTitle } from '@/components/ui/heading';
import { UtilityLink } from '@/components/ui/utility-link';
import { CourseParticipantsDialog } from './CourseParticipantsDialog';
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogHeading,
  useDialog,
} from '@/components/ui/dialog';
import { SortableVideoItem } from './SortableVideoItem';
import { PickFromLibraryDialog } from './PickFromLibraryDialog';
import { ShareLinkDialog } from './ShareLinkDialog';

type MobileTab = 'videos' | 'player';

interface VideoCourseDetailViewProps {
  course: VideoCourse | null;
  courseId: number | null;
  isLoading: boolean;
  error: string | null;
  selectedVideo: VideoInCourse | null;
  deleteError: string | null;
  isDeleting: boolean;
  /** Id of the video whose removal is in flight, or null when idle. */
  removingVideoId: number | null;
  isReordering: boolean;
  isEditing: boolean;
  editedName: string;
  editedDescription: string;
  updateError: string | null;
  isUpdating: boolean;
  isAddModalOpen: boolean;
  isMembersModalOpen: boolean;
  isLeaving: boolean;
  mobileTab: MobileTab;
  isMobile: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  youtubeStartSeconds: number | null;
  youtubeSeekId: number;
  shareSlug: string;
  shareLink: string | null;
  isGeneratingLink: boolean;
  isDeletingLink: boolean;
  isCopied: boolean;
  onMobileTabChange: (tab: MobileTab) => void;
  onOpenAddModalChange: (open: boolean) => void;
  onOpenMembersModalChange: (open: boolean) => void;
  onStartEditing: () => void;
  onCancelEdit: () => void;
  onEditedNameChange: (name: string) => void;
  onEditedDescriptionChange: (description: string) => void;
  onUpdateCourse: () => void;
  onDeleteCourse: () => void;
  onLeaveGroup: () => void;
  onVideoSelect: (videoId: number) => void;
  onRemoveVideo: (videoId: number) => Promise<void> | void;
  onDragEnd: (event: DragEndEvent) => Promise<void> | void;
  onVideoCanPlay: () => void;
  onVideoPlayFromTime: (videoId: number, startTime: string) => void;
  onGenerateShareLink: (shareSlug: string) => Promise<void> | void;
  onDeleteShareLink: () => void;
  onCopyShareLink: () => void;
}

function GroupEditDialog({
  isOpen,
  editedName,
  editedDescription,
  updateError,
  isUpdating,
  onOpenChange,
  onNameChange,
  onDescriptionChange,
  onSave,
}: {
  isOpen: boolean;
  editedName: string;
  editedDescription: string;
  updateError: string | null;
  isUpdating: boolean;
  onOpenChange: (open: boolean) => void;
  onNameChange: (name: string) => void;
  onDescriptionChange: (description: string) => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();

  const dialog = useDialog({
    open: isOpen,
    onOpenChange,
    onRequestClose: (event) => {
      if (isUpdating) event.preventDefault();
    },
  });

  return (
    <Dialog {...dialog.dialogProps} width="min(32rem, 92vw)">
      {isOpen && <DialogContent>
        <DialogHeader>
          <DialogHeading {...dialog.headingProps}>{t('videos.courseDetail.editTitle')}</DialogHeading>
        </DialogHeader>
        <DialogBody>
          <p className="mb-4 text-std-16N-170 text-solid-gray-700">
            {t('videos.courseDetail.editDescription', 'Update the course name and description.')}
          </p>
          <div className="space-y-4">
            {updateError && <ErrorMessage message={updateError} />}
            <div className="flex flex-col gap-2">
              <Label htmlFor="course-edit-name">{t('videos.courses.nameLabel')}</Label>
              <Input
                id="course-edit-name"
                type="text"
                value={editedName}
                onChange={(event) => onNameChange(event.target.value)}
                disabled={isUpdating}
                blockSize="md"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="course-edit-description">{t('videos.courses.descriptionLabel')}</Label>
              <Textarea
                id="course-edit-description"
                value={editedDescription}
                onChange={(event) => onDescriptionChange(event.target.value)}
                disabled={isUpdating}
                rows={3}
                className="resize-none"
              />
            </div>
          </div>
        </DialogBody>
        <DialogActions>
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isUpdating}
            >
              <X className="w-3.5 h-3.5" />
              {t('common.actions.cancel')}
            </Button>
            <Button
              type="button"
              onClick={onSave}
              disabled={isUpdating || !editedName.trim()}
            >
              {isUpdating ? <InlineSpinner className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
              {isUpdating ? t('common.actions.saving') : t('common.actions.save')}
            </Button>
          </div>
        </DialogActions>
      </DialogContent>}
    </Dialog>
  );
}

function GroupVideoList({
  course,
  selectedVideo,
  deleteError,
  isMobile,
  mobileTab,
  sensors,
  onOpenAdd,
  onVideoSelect,
  onMobileTabChange,
  onRemoveVideo,
  removingVideoId,
  isMutationPending,
  onDragEnd,
  canManage,
}: {
  course: VideoCourse;
  selectedVideo: VideoInCourse | null;
  deleteError: string | null;
  isMobile: boolean;
  mobileTab: MobileTab;
  sensors: ReturnType<typeof useSensors>;
  onOpenAdd: () => void;
  onVideoSelect: (videoId: number) => void;
  onMobileTabChange: (tab: MobileTab) => void;
  onRemoveVideo: (videoId: number) => Promise<void> | void;
  removingVideoId: number | null;
  isMutationPending: boolean;
  onDragEnd: (event: DragEndEvent) => Promise<void> | void;
  canManage: boolean;
}) {
  const { t } = useTranslation();

  return (
    <aside className={`lg:col-span-1 flex min-h-0 flex-col ${mobileTab === 'videos' ? 'flex' : 'hidden lg:flex'}`}>
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden border border-solid-gray-420 bg-white">
        {deleteError ? (
          <div className="shrink-0 px-5 pt-4">
            <ErrorMessage message={deleteError} />
          </div>
        ) : null}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-solid-gray-200 px-5 py-4">
          <Heading size="18" className="shrink-0">
            <HeadingTitle level="h2">{t('videos.courseDetail.videoListTitle')}</HeadingTitle>
          </Heading>
          <ChipLabel variant="filled-1" color="gray" className="min-h-0 shrink-0 text-oln-14N-100">
            {t('videos.courseDetail.videoCount', { count: course.videos?.length ?? 0 })}
          </ChipLabel>
          {canManage ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenAdd}
              disabled={isMutationPending}
              aria-label={t('videos.courseDetail.pickFromLibrary')}
              className="ml-auto min-w-9 shrink-0 px-2.5"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {course.videos && course.videos.length > 0 ? (
            <DndContext
              // SortableVideoItem disables dragging on mobile. Keep the sensor
              // list stable across resize for dnd-kit's effect dependencies.
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={(event) => { void onDragEnd(event); }}
            >
              <SortableContext items={course.videos.map((video) => video.id)} strategy={verticalListSortingStrategy}>
                {course.videos.map((video) => (
                  <SortableVideoItem
                    key={video.id}
                    video={video}
                    isSelected={selectedVideo?.id === video.id}
                    isMobile={isMobile}
                    canManage={canManage}
                    onSelect={(videoId) => {
                      onVideoSelect(videoId);
                      if (isMobile) onMobileTabChange('player');
                    }}
                    onRemove={(id) => { void onRemoveVideo(id); }}
                    isRemoving={removingVideoId === video.id}
                    isMutationPending={isMutationPending}
                  />
                ))}
              </SortableContext>
            </DndContext>
          ) : (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-std-16N-170 text-solid-gray-600">
                {t('videos.courseDetail.videoListEmpty')}
              </p>
              {canManage ? (
                <>
                  <p className="text-dns-14N-130 text-solid-gray-600">
                    {t('videos.courseDetail.videoListEmptyHint')}
                  </p>
                  <Button type="button" variant="outline" size="sm" onClick={onOpenAdd} disabled={isMutationPending}>
                    {t('videos.courseDetail.pickFromLibrary')}
                  </Button>
                </>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function GroupPlayerPanel({
  courseId,
  selectedVideo,
  mobileTab,
  videoRef,
  youtubeStartSeconds,
  youtubeSeekId,
  onVideoCanPlay,
  canManage,
}: {
  courseId: number | null;
  selectedVideo: VideoInCourse | null;
  mobileTab: MobileTab;
  videoRef: RefObject<HTMLVideoElement | null>;
  youtubeStartSeconds: number | null;
  youtubeSeekId: number;
  onVideoCanPlay: () => void;
  canManage: boolean;
}) {
  const { t } = useTranslation();

  return (
    <section className={`lg:col-span-2 flex min-h-0 flex-col gap-4 ${mobileTab === 'player' ? 'flex' : 'hidden lg:flex'}`}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-solid-gray-420 bg-white">
        <div className="flex min-w-0 shrink-0 items-center justify-between gap-4 border-b border-solid-gray-200 px-5 py-4">
          <Heading size="18" className="min-w-0 flex-1 truncate">
            <HeadingTitle level="h2">
              {selectedVideo ? selectedVideo.title : t('videos.courseDetail.playerPlaceholder')}
            </HeadingTitle>
          </Heading>
          <div className="flex shrink-0 items-center gap-3">
            {courseId && canManage ? <DashboardButton courseId={courseId} size="sm" /> : null}
          </div>
        </div>
        <div className="aspect-video lg:aspect-auto lg:flex-1 bg-solid-gray-800 flex items-center justify-center lg:min-h-0">
          {selectedVideo ? (
            features.youtube && selectedVideo.source_type === 'youtube' && selectedVideo.youtube_embed_url ? (
              <iframe
                key={`${selectedVideo.id}-${youtubeSeekId}`}
                className="w-full h-full"
                src={buildYoutubeEmbedSrc(selectedVideo.youtube_embed_url, youtubeStartSeconds)}
                title={selectedVideo.title}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            ) : selectedVideo.file ? (
              <video
                ref={videoRef}
                key={selectedVideo.id}
                controls
                className="w-full h-full object-contain"
                src={apiClient.getVideoUrl(selectedVideo.file)}
                onCanPlay={onVideoCanPlay}
              >
                {t('common.messages.browserNoVideoSupport')}
              </video>
            ) : (
              <p className="text-solid-gray-200 text-std-16N-170">{t('videos.courseDetail.videoNoFile')}</p>
            )
          ) : (
            <p className="text-solid-gray-200 text-std-16N-170 text-center px-4">{t('videos.courseDetail.playerPlaceholder')}</p>
          )}
        </div>
      </div>
    </section>
  );
}

function GroupMobileNav({
  mobileTab,
  onChange,
}: {
  mobileTab: MobileTab;
  onChange: (tab: MobileTab) => void;
}) {
  const { t } = useTranslation();
  const mobileTabIcon: Record<MobileTab, typeof List> = { videos: List, player: Play };
  const mobileTabLabel: Record<MobileTab, string> = {
    videos: t('videos.courseDetail.mobileTabs.videos'),
    player: t('videos.courseDetail.mobileTabs.player'),
  };

  return (
    <nav className="fixed bottom-0 left-0 z-50 flex min-h-16 w-full items-center justify-around border-t border-solid-gray-420 bg-white px-4 pb-[env(safe-area-inset-bottom)] lg:hidden">
      {(['videos', 'player'] as MobileTab[]).map((tab) => {
        const Icon = mobileTabIcon[tab];
        const isActive = mobileTab === tab;
        return (
          <button
            key={tab}
            type="button"
            onClick={() => onChange(tab)}
            className={`flex flex-col items-center justify-center gap-1 px-4 py-1 transition-colors ${
              isActive
                ? 'border-b-2 border-key-900 text-key-900'
                : 'text-solid-gray-600 hover:text-key-900'
            }`}
          >
            <Icon className="w-5 h-5" />
            <span className="text-dns-14N-120 font-medium">{mobileTabLabel[tab]}</span>
          </button>
        );
      })}
    </nav>
  );
}

export function VideoCourseDetailView({
  course,
  courseId,
  isLoading,
  error,
  selectedVideo,
  deleteError,
  isDeleting,
  isEditing,
  editedName,
  editedDescription,
  updateError,
  isUpdating,
  isAddModalOpen,
  isMembersModalOpen,
  isLeaving,
  mobileTab,
  isMobile,
  videoRef,
  youtubeStartSeconds,
  youtubeSeekId,
  shareSlug,
  shareLink,
  isGeneratingLink,
  isDeletingLink,
  isCopied,
  onMobileTabChange,
  onOpenAddModalChange,
  onOpenMembersModalChange,
  onStartEditing,
  onCancelEdit,
  onEditedNameChange,
  onEditedDescriptionChange,
  onUpdateCourse,
  onDeleteCourse,
  onLeaveGroup,
  onVideoSelect,
  onRemoveVideo,
  removingVideoId,
  isReordering,
  onDragEnd,
  onVideoCanPlay,
  onVideoPlayFromTime,
  onGenerateShareLink,
  onDeleteShareLink,
  onCopyShareLink,
}: VideoCourseDetailViewProps) {
  const { t } = useTranslation();
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const canManage = course?.access_role !== 'member';
  const isMutationPending = isDeleting || isReordering || removingVideoId !== null;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  return (
    <>
      {isLoading ? (
        <LoadingSpinner fullScreen />
      ) : error && !course ? (
        <div className="flex min-h-[calc(100dvh-var(--app-header-offset,5rem))] flex-col items-center justify-center gap-4">
          <ErrorMessage message={error} />
          <UtilityLink asChild>
            <Link href="/videos/courses" className="inline-flex items-center gap-1">
              <ArrowLeft className="w-4 h-4" />
              {t('common.actions.backToList')}
            </Link>
          </UtilityLink>
        </div>
      ) : !course ? (
        <div className="flex min-h-[calc(100dvh-var(--app-header-offset,5rem))] items-center justify-center">
          <p className="text-solid-gray-700">{t('common.messages.courseNotFound')}</p>
        </div>
      ) : (
        <>
          {canManage ? <GroupEditDialog
            isOpen={isEditing}
            editedName={editedName}
            editedDescription={editedDescription}
            updateError={updateError}
            isUpdating={isUpdating}
            onOpenChange={(open) => !open && onCancelEdit()}
            onNameChange={onEditedNameChange}
            onDescriptionChange={onEditedDescriptionChange}
            onSave={onUpdateCourse}
          /> : null}

          {canManage && isMembersModalOpen && courseId ? (
            <CourseParticipantsDialog
              courseId={courseId}
              isOpen={isMembersModalOpen}
              onOpenChange={onOpenMembersModalChange}
            />
          ) : null}

          {canManage && isShareDialogOpen && (
            <ShareLinkDialog
              key={shareSlug}
              isOpen={isShareDialogOpen}
              shareSlug={shareSlug}
              shareLink={shareLink}
              isGeneratingLink={isGeneratingLink}
              isDeletingLink={isDeletingLink}
              isCopied={isCopied}
              onOpenChange={setIsShareDialogOpen}
              onGenerate={onGenerateShareLink}
              onDelete={onDeleteShareLink}
              onCopy={onCopyShareLink}
            />
          )}

          <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 overflow-y-auto px-4 py-4 pb-[calc(5rem+env(safe-area-inset-bottom))] sm:px-6 lg:h-[calc(100dvh-var(--app-header-offset,5rem))] lg:gap-5 lg:overflow-hidden lg:px-8 lg:pb-4">
            <div className="shrink-0 space-y-4">
              <Breadcrumbs aria-label={t('common.actions.backToList')}>
                <BreadcrumbsLabel className="sr-only">
                  {t('common.actions.backToList')}
                </BreadcrumbsLabel>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbLink asChild>
                      <Link href="/videos/courses">{t('navigation.coursesNav')}</Link>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbItem isCurrent>{course.name}</BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumbs>

              <header className="flex min-w-0 items-center justify-end">
                {/* 見出しは非表示にしたが、ページの h1 として構造には残す。 */}
                <h1 className="sr-only">{course.name}</h1>
                {canManage ? <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onOpenMembersModalChange(true)}
                    aria-label={t('videos.courseMembers.open')}
                    className="min-w-9 px-2.5 sm:min-w-20 sm:px-3"
                  >
                    <Users className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{t('videos.courseMembers.open')}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setIsShareDialogOpen(true)}
                    aria-label={t('videos.courseDetail.shareOpen')}
                    className="min-w-9 px-2.5 sm:min-w-20 sm:px-3"
                  >
                    <Share2 className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{t('videos.courseDetail.shareOpen')}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onStartEditing}
                    disabled={isMutationPending}
                    title={t('videos.courseDetail.editTitle')}
                    aria-label={t('videos.courseDetail.editTitle')}
                    className="min-w-9 px-2.5 sm:min-w-20 sm:px-3"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{t('videos.courseDetail.editTitle')}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="text"
                    size="sm"
                    onClick={onDeleteCourse}
                    disabled={isMutationPending}
                    title={t('videos.courseDetail.delete')}
                    aria-label={t('videos.courseDetail.delete')}
                    className="min-w-9 px-2.5 text-error-1 hover:bg-red-50 sm:min-w-20 sm:px-3"
                  >
                    {isDeleting ? (
                      <InlineSpinner className="h-3.5 w-3.5" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                    <span className="hidden sm:inline">{t('videos.courseDetail.delete')}</span>
                  </Button>
                </div> : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onLeaveGroup}
                    disabled={isLeaving}
                    aria-label={t('videos.courseDetail.leave')}
                    className="min-w-9 px-2.5 sm:min-w-20 sm:px-3"
                  >
                    {isLeaving ? <InlineSpinner className="h-3.5 w-3.5" /> : <LogOut className="h-3.5 w-3.5" />}
                    <span className="hidden sm:inline">{t('videos.courseDetail.leave')}</span>
                  </Button>
                )}
              </header>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-6 lg:grid lg:grid-cols-4 lg:items-stretch">
              <GroupVideoList
                course={course}
                selectedVideo={selectedVideo}
                deleteError={deleteError}
                isMobile={isMobile}
                mobileTab={mobileTab}
                sensors={sensors}
                onOpenAdd={() => onOpenAddModalChange(true)}
                onVideoSelect={onVideoSelect}
                onMobileTabChange={onMobileTabChange}
                onRemoveVideo={onRemoveVideo}
                removingVideoId={removingVideoId}
                isMutationPending={isMutationPending}
                onDragEnd={(event) => { void onDragEnd(event); }}
                canManage={canManage}
              />

              <GroupPlayerPanel
                courseId={courseId}
                selectedVideo={selectedVideo}
                mobileTab={mobileTab}
                videoRef={videoRef}
                youtubeStartSeconds={youtubeStartSeconds}
                youtubeSeekId={youtubeSeekId}
                onVideoCanPlay={onVideoCanPlay}
                canManage={canManage}
              />

              {/* Keep one mounted chat when the viewport or mobile tab changes. */}
              <aside className={`min-h-0 shrink-0 flex-col lg:col-span-1 ${mobileTab === 'player' ? 'flex' : 'hidden lg:flex'}`}>
                <ChatPanel
                  courseId={courseId ?? undefined}
                  showHistory={canManage}
                  onVideoPlay={onVideoPlayFromTime}
                  className="h-[480px] lg:h-full lg:min-h-0 lg:flex-1"
                />
              </aside>
            </div>
          </div>

          <GroupMobileNav mobileTab={mobileTab} onChange={onMobileTabChange} />

          {canManage ? <PickFromLibraryDialog
            isOpen={isAddModalOpen}
            onOpenChange={onOpenAddModalChange}
            courseId={courseId}
            course={course}
          /> : null}
        </>
      )}
    </>
  );
}
