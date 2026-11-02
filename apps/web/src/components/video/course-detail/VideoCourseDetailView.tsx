import { CourseLearningDetails } from '@/components/video/CourseLearningDetails';
import { features } from "@/lib/deployment";
import { useId, useRef, useState, type RefObject } from 'react';
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
  BarChart3,
  Pencil,
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
import { ViewerActionsMenu } from '@/components/video/ViewerActionsMenu';
import { ViewerHeader } from '@/components/video/ViewerHeader';
import { PanelTabs, type PanelTab } from '@/components/video/ViewerPanels';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { DashboardDialog } from '@/components/dashboard/DashboardDialog';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { ErrorMessage } from '@/components/auth/ErrorMessage';
import { Button } from '@/components/ui/button';
import { MenuList, MenuListItem, MenuListItemButton } from '@/components/ui/menu-list';
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
  isMobile: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  youtubeStartSeconds: number | null;
  youtubeSeekId: number;
  shareSlug: string;
  shareLink: string | null;
  isGeneratingLink: boolean;
  isDeletingLink: boolean;
  isCopied: boolean;
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
  isMobile,
  sensors,
  onOpenAdd,
  onVideoSelect,
  onRemoveVideo,
  removingVideoId,
  isMutationPending,
  onDragEnd,
  canManage,
}: {
  course: VideoCourse;
  selectedVideo: VideoInCourse | null;
  isMobile: boolean;
  sensors: ReturnType<typeof useSensors>;
  onOpenAdd: () => void;
  onVideoSelect: (videoId: number) => void;
  onRemoveVideo: (videoId: number) => Promise<void> | void;
  removingVideoId: number | null;
  isMutationPending: boolean;
  onDragEnd: (event: DragEndEvent) => Promise<void> | void;
  canManage: boolean;
}) {
  const { t } = useTranslation();

  return (
    <aside className="flex h-full min-h-0 flex-col">
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden border border-solid-gray-420 bg-white">
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
  selectedVideo,
  videoRef,
  youtubeStartSeconds,
  youtubeSeekId,
  onVideoCanPlay,
}: {
  selectedVideo: VideoInCourse | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  youtubeStartSeconds: number | null;
  youtubeSeekId: number;
  onVideoCanPlay: () => void;
}) {
  const { t } = useTranslation();

  return (
    <section className="flex min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white">
        <div className="aspect-video max-h-[45dvh] bg-black flex items-center justify-center lg:max-h-[72dvh]">
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
        <div className="flex min-w-0 shrink-0 items-center justify-between gap-4 px-5 py-4">
          <Heading size="18" className="min-w-0 flex-1 truncate">
            <HeadingTitle level="h2">
              {selectedVideo ? selectedVideo.title : t('videos.courseDetail.playerPlaceholder')}
            </HeadingTitle>
          </Heading>
        </div>
      </div>
    </section>
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
  isMobile,
  videoRef,
  youtubeStartSeconds,
  youtubeSeekId,
  shareSlug,
  shareLink,
  isGeneratingLink,
  isDeletingLink,
  isCopied,
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
  const [isDashboardOpen, setIsDashboardOpen] = useState(false);
  const [requestedTab, setPanelTab] = useState<PanelTab>('assistant');
  const panelId = useId();
  const pageRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const panelTabs: PanelTab[] = ['videos', 'assistant'];
  const activeTab = panelTabs.includes(requestedTab) ? requestedTab : 'assistant';
  const panelProps = (tab: PanelTab) => ({
    id: `${panelId}-panel-${tab}`,
    role: 'tabpanel',
    'aria-labelledby': `${panelId}-tab-${tab}`,
    className: `absolute inset-0 flex min-h-0 flex-col ${activeTab === tab ? '' : 'invisible'}`,
  });
  const revealPlayer = () => {
    if (pageRef.current) pageRef.current.scrollTop = 0;
    if (playerRef.current) playerRef.current.scrollTop = 0;
  };

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
        <div className="flex min-h-dvh flex-col items-center justify-center gap-4">
          <ErrorMessage message={error} />
          <UtilityLink asChild>
            <Link href="/videos/courses" className="inline-flex items-center gap-1">
              <ArrowLeft className="w-4 h-4" />
              {t('common.actions.backToList')}
            </Link>
          </UtilityLink>
        </div>
      ) : !course ? (
        <div className="flex min-h-dvh items-center justify-center">
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

          {canManage && courseId ? <DashboardDialog courseId={courseId} open={isDashboardOpen} onOpenChange={setIsDashboardOpen} /> : null}

          <div ref={pageRef} className="flex h-dvh flex-col overflow-y-auto bg-white lg:overflow-hidden">
            <ViewerHeader title={course.name} backHref="/videos/courses">
                {canManage ? <ViewerActionsMenu label={t('videos.courseDetail.manage')}>
                  <MenuList>
                    <MenuListItem>
                      <MenuListItemButton type="box" size="regular" onClick={() => setIsShareDialogOpen(true)}>
                        <Share2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span>{t('videos.courseDetail.shareOpen')}</span>
                      </MenuListItemButton>
                    </MenuListItem>
                    <MenuListItem>
                      <MenuListItemButton type="box" size="regular" onClick={() => onOpenMembersModalChange(true)}>
                        <Users className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span>{t('videos.courseMembers.open')}</span>
                      </MenuListItemButton>
                    </MenuListItem>
                    {courseId ? <MenuListItem>
                      <MenuListItemButton type="box" size="regular" onClick={() => setIsDashboardOpen(true)}>
                        <BarChart3 className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span>{t('dashboard.button')}</span>
                      </MenuListItemButton>
                    </MenuListItem> : null}
                    <MenuListItem>
                      <MenuListItemButton type="box" size="regular" onClick={onStartEditing}
                        disabled={isMutationPending} title={t('videos.courseDetail.editTitle')}
                        className="disabled:cursor-not-allowed disabled:opacity-50">
                        <Pencil className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span>{t('videos.courseDetail.editTitle')}</span>
                      </MenuListItemButton>
                    </MenuListItem>
                    <MenuListItem className="mt-1 border-t border-solid-gray-200 pt-1">
                      <MenuListItemButton type="box" size="regular" onClick={onDeleteCourse}
                        disabled={isMutationPending} title={t('videos.courseDetail.delete')}
                        className="text-error-1 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50">
                        {isDeleting ? <InlineSpinner className="h-4 w-4 shrink-0" /> : <Trash2 className="h-4 w-4 shrink-0" aria-hidden="true" />}
                        <span>{t('videos.courseDetail.delete')}</span>
                      </MenuListItemButton>
                    </MenuListItem>
                  </MenuList>
                </ViewerActionsMenu> : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onLeaveGroup}
                    disabled={isLeaving}
                    aria-label={t('videos.courseDetail.leave')}
                    className="min-w-9 px-2.5 sm:min-w-20 sm:px-3 bg-white text-key-900"
                  >
                    {isLeaving ? <InlineSpinner className="h-3.5 w-3.5" /> : <LogOut className="h-3.5 w-3.5" />}
                    <span className="inline">{t('videos.courseDetail.leave')}</span>
                  </Button>
                )}
            </ViewerHeader>

            {deleteError ? <div className="shrink-0"><ErrorMessage message={deleteError} /></div> : null}

            <main className="flex flex-1 flex-col lg:grid lg:min-h-0 lg:grid-cols-[minmax(0,7fr)_minmax(22rem,3fr)]">
              <div ref={playerRef} className="shrink-0 lg:min-h-0 lg:overflow-y-auto">
                <GroupPlayerPanel
                  selectedVideo={selectedVideo}
                  videoRef={videoRef}
                  youtubeStartSeconds={youtubeStartSeconds}
                  youtubeSeekId={youtubeSeekId}
                  onVideoCanPlay={onVideoCanPlay}
                />

                {courseId ? <CourseLearningDetails key={courseId} courseId={courseId}
                  videoId={selectedVideo?.id} videoTitle={selectedVideo?.title} videoDescription={selectedVideo?.description} courseDescription={course.description}
                  onVideoPlay={(id, time) => { onVideoPlayFromTime(id, time); revealPlayer(); }} /> : null}
              </div>
              <aside className="flex min-h-[28rem] flex-1 flex-col border-t border-solid-gray-420 pb-[env(safe-area-inset-bottom)] lg:min-h-0 lg:border-l lg:border-t-0">
                <PanelTabs tabs={panelTabs} activeTab={activeTab} idPrefix={panelId} onChange={setPanelTab} />
                <div className="relative min-h-0 flex-1">
                  <div {...panelProps('videos')}>
                    <GroupVideoList
                      course={course}
                      selectedVideo={selectedVideo}
                      isMobile={isMobile}
                      sensors={sensors}
                      onOpenAdd={() => onOpenAddModalChange(true)}
                      onVideoSelect={(id) => { onVideoSelect(id); revealPlayer(); }}
                      onRemoveVideo={onRemoveVideo}
                      removingVideoId={removingVideoId}
                      isMutationPending={isMutationPending}
                      onDragEnd={(event) => { void onDragEnd(event); }}
                      canManage={canManage}
                    />

                  </div>
                  <div {...panelProps('assistant')}>
                    <ChatPanel
                      courseId={courseId ?? undefined}
                      showHistory={canManage}
                      showTitle={false}
                      onVideoPlay={(id, time) => { onVideoPlayFromTime(id, time); revealPlayer(); }}
                      className="min-h-0 flex-1 border-0"
                    />
                  </div>
                </div>
              </aside>
            </main>
          </div>

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
