import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoCourse } from '@/lib/api';
import { Link } from '@/lib/i18n';
import { ErrorMessage } from '@/components/auth/ErrorMessage';
import { handleAsyncError } from '@/lib/utils/errorHandling';
import { useToast } from '@/components/common/feedback';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TagFilterPanel } from '@/components/video/TagFilterPanel';
import { TagManagementModal } from '@/components/video/TagManagementModal';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { UtilityLink } from '@/components/ui/utility-link';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DialogScrollArea } from '@/components/ui/dialog';
import { useTags } from '@/hooks/useTags';
import { useAddableVideosQuery, useAddVideosToCourseMutation } from '@/hooks/useVideoCourseDetailData';
import { Dialog, DialogActions, DialogBody, DialogContent, DialogHeader, DialogHeading, useDialog } from '@/components/ui/dialog';

const ORDERING_OPTIONS = ['uploaded_at_desc', 'uploaded_at_asc', 'title_asc', 'title_desc'] as const;
type OrderingOption = (typeof ORDERING_OPTIONS)[number];

interface PickFromLibraryDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  courseId: number | null;
  course: VideoCourse | null;
  onVideosAdded?: () => void;
}

export function PickFromLibraryDialog({
  isOpen,
  onOpenChange,
  courseId,
  course,
  onVideosAdded,
}: PickFromLibraryDialogProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const { tags } = useTags({ enabled: isOpen });

  const [addError, setAddError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (addError) errorRef.current?.focus(); }, [addError]);

  const [videoSearchInput, setVideoSearchInput] = useState('');
  const [videoSearch, setVideoSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [ordering, setOrdering] = useState<OrderingOption>('uploaded_at_desc');
  const [selectedVideos, setSelectedVideos] = useState<number[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);
  const [isTagManagementOpen, setIsTagManagementOpen] = useState(false);

  const handleOrderingChange = useCallback((value: string) => {
    if (ORDERING_OPTIONS.includes(value as OrderingOption)) {
      setOrdering(value as OrderingOption);
    }
  }, []);

  const handleTagToggle = useCallback((tagId: number) => {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId],
    );
  }, []);

  const handleTagClear = useCallback(() => setSelectedTagIds([]), []);

  useEffect(() => {
    const handler = setTimeout(() => setVideoSearch(videoSearchInput), 300);
    return () => clearTimeout(handler);
  }, [videoSearchInput]);

  const {
    videos: availableVideos,
    isLoading: isLoadingVideos,
    error: videosError,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    isFetching,
    refetch: refetchVideos,
    sentinelRef,
  } = useAddableVideosQuery({
    isOpen,
    courseId,
    course,
    q: videoSearch.trim(),
    status: statusFilter,
    ordering,
    tagIds: selectedTagIds,
  });

  const addVideosMutation = useAddVideosToCourseMutation(courseId, onVideosAdded);

  const handleAddVideos = async () => {
    if (!courseId || selectedVideos.length === 0 || addVideosMutation.isPending) return;
    setAddError(null);
    try {
      const result = await addVideosMutation.mutateAsync(selectedVideos);
      onOpenChange(false);
      setSelectedVideos([]);
      if (result.skipped_count > 0) {
        toast({
          message: t('videos.courseDetail.addResult', { added: result.added_count, skipped: result.skipped_count }),
          variant: 'info',
        });
      }
    } catch (err) {
      handleAsyncError(err, t('videos.courseDetail.addError'), setAddError);
    }
  };

  const dialog = useDialog({
    open: isOpen,
    onOpenChange,
    onRequestClose: (event) => {
      if (addVideosMutation.isPending) event.preventDefault();
    },
  });

  return (
    <>
      <Dialog {...dialog.dialogProps} scroll="inner" width="min(42rem, 95vw)">
        {isOpen && <DialogContent>
          <DialogHeader>
            <DialogHeading {...dialog.headingProps}>{t('videos.courseDetail.pickFromLibrary')}</DialogHeading>
          </DialogHeader>
          <DialogScrollArea>
            <DialogBody>
              <p className="mb-4 text-std-16N-170 text-solid-gray-700">
                {t('videos.courseDetail.pickFromLibraryDescription')}
              </p>
              {addError && <div ref={errorRef} tabIndex={-1} className="mb-4 focus-visible:outline-4 focus-visible:outline-black"><ErrorMessage message={addError} /></div>}
              <fieldset disabled={addVideosMutation.isPending} className="min-w-0 space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    disabled={addVideosMutation.isPending}
                    aria-label={t('videos.courseDetail.searchPlaceholder')}
                    value={videoSearchInput}
                    onChange={(event) => setVideoSearchInput(event.target.value)}
                    blockSize="md"
                    className="w-full md:w-1/2"
                  />
                  <Select disabled={addVideosMutation.isPending} value={statusFilter || 'all'} onValueChange={(value) => setStatusFilter(value === 'all' ? '' : value)}>
                    <SelectTrigger aria-label={t('videos.detail.statusSection')} blockSize="md" className="w-auto min-w-[10rem] max-w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('videos.courseDetail.statusFilter.all')}</SelectItem>
                      <SelectItem value="completed">{t('videos.courseDetail.statusFilter.completed')}</SelectItem>
                      <SelectItem value="processing">{t('videos.courseDetail.statusFilter.processing')}</SelectItem>
                      <SelectItem value="indexing">{t('videos.courseDetail.statusFilter.indexing')}</SelectItem>
                      <SelectItem value="pending">{t('videos.courseDetail.statusFilter.pending')}</SelectItem>
                      <SelectItem value="error">{t('videos.courseDetail.statusFilter.error')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select disabled={addVideosMutation.isPending} value={ordering} onValueChange={handleOrderingChange}>
                    <SelectTrigger aria-label={t('videos.list.sortLabel')} blockSize="md" className="w-auto min-w-[12rem] max-w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="uploaded_at_desc">{t('videos.courseDetail.ordering.uploadedDesc')}</SelectItem>
                      <SelectItem value="uploaded_at_asc">{t('videos.courseDetail.ordering.uploadedAsc')}</SelectItem>
                      <SelectItem value="title_asc">{t('videos.courseDetail.ordering.titleAsc')}</SelectItem>
                      <SelectItem value="title_desc">{t('videos.courseDetail.ordering.titleDesc')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedVideos(availableVideos.map((video) => video.id))}
                    disabled={addVideosMutation.isPending || isLoadingVideos || !availableVideos.length}
                  >
                    {t('videos.courseDetail.selectAll')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedVideos([])}
                    disabled={addVideosMutation.isPending || selectedVideos.length === 0}
                  >
                    {t('videos.courseDetail.clearSelection')}
                  </Button>
                </div>
                <TagFilterPanel
                  tags={tags}
                  selectedTagIds={selectedTagIds}
                  onToggle={handleTagToggle}
                  onClear={handleTagClear}
                  onManageTags={() => setIsTagManagementOpen(true)}
                  disabled={isLoadingVideos || addVideosMutation.isPending}
                />
                {isLoadingVideos ? (
                  <div className="flex justify-center py-8"><LoadingSpinner /></div>
                ) : !videosError && availableVideos.length === 0 && !hasNextPage ? (
                  <div className="flex flex-col items-center gap-3 py-8 text-center">
                    <p className="text-std-16N-170 text-solid-gray-600">
                      {t('videos.courseDetail.noAvailableVideos')}
                    </p>
                    <p className="text-dns-14N-130 text-solid-gray-600">
                      {t('videos.courseDetail.noAvailableVideosHint')}
                    </p>
                    <UtilityLink asChild>
                      <Link href="/videos">{t('videos.goToLibrary')}</Link>
                    </UtilityLink>
                  </div>
                ) : (
                  <div className="space-y-2 max-h-[400px] overflow-y-auto">
                    {availableVideos.map((video) => (
                      <div key={video.id} className="flex items-start gap-3 p-3 border border-solid-gray-200 rounded-8 hover:bg-solid-gray-50 transition-colors">
                        <Checkbox
                          className="mt-1 shrink-0"
                          disabled={addVideosMutation.isPending}
                          id={`video-${video.id}`}
                          checked={selectedVideos.includes(video.id)}
                          onCheckedChange={(checked: boolean | 'indeterminate') => {
                            if (checked === true) setSelectedVideos([...selectedVideos, video.id]);
                            else if (checked === false) setSelectedVideos(selectedVideos.filter((id) => id !== video.id));
                          }}
                        />
                        <Label htmlFor={`video-${video.id}`} className="min-w-0 flex-1 cursor-pointer [overflow-wrap:anywhere]">
                          <div className="text-std-16B-170 text-solid-gray-800">{video.title}</div>
                          <div className="text-dns-14N-130 text-solid-gray-600">{video.description || t('common.messages.noDescription')}</div>
                        </Label>
                      </div>
                    ))}
                    {hasNextPage && !addVideosMutation.isPending && (
                      <div ref={sentinelRef} className="h-1" aria-hidden="true" />
                    )}
                    {videosError && (
                      <ErrorMessage message={videosError} />
                    )}
                    {(hasNextPage || videosError) && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={isFetching}
                        aria-busy={isFetching}
                        onClick={() => { void (videosError && !isFetchNextPageError ? refetchVideos() : fetchNextPage()); }}
                      >
                        {isFetchingNextPage ? <><InlineSpinner />{t('videos.list.loadingMore')}</> :
                          t(videosError ? 'videos.courseDetail.retryLoadVideos' : 'videos.courseDetail.loadMoreVideos')}
                      </Button>
                    )}
                  </div>
                )}
              </fieldset>
            </DialogBody>
          </DialogScrollArea>
          <DialogActions>
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" disabled={addVideosMutation.isPending} onClick={() => onOpenChange(false)}>
                {t('common.actions.cancel')}
              </Button>
              <Button
                type="button"
                onClick={() => { void handleAddVideos(); }}
                disabled={addVideosMutation.isPending || selectedVideos.length === 0}
              >
                {addVideosMutation.isPending && <InlineSpinner className="w-3.5 h-3.5" />}
                {addVideosMutation.isPending ? t('videos.courseDetail.adding') : t('videos.courseDetail.add')}
              </Button>
            </div>
          </DialogActions>
        </DialogContent>}
      </Dialog>
      {isTagManagementOpen && (
        <TagManagementModal isOpen={isTagManagementOpen} onClose={() => setIsTagManagementOpen(false)} />
      )}
    </>
  );
}
