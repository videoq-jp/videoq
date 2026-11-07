import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, MessageCircle, Pin, ThumbsUp } from 'lucide-react';
import type { QaQuestion, QaReply } from '@videoq/trpc';
import { trpc } from '@/lib/trpc';
import { Link, useI18nLocation } from '@/lib/i18n';
import { useAuthSession } from '@/lib/authSession';
import { useConfirm } from '@/components/common/feedback';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';

interface Props {
  courseId: number;
  shareSlug?: string;
  videoId?: number;
  videoTitle?: string;
  active: boolean;
  onVideoPlay: (id: number, time: string) => void;
}
export function CourseQaPanel(props: Props) {
  const session = useAuthSession();
  const { t } = useTranslation();
  if (session.isPending) return <p role="status">{t('qa.loading')}</p>;
  return <QaSession key={JSON.stringify([props.courseId, props.shareSlug, session.data?.user.id])} {...props} />;
}

function Author({ author, date }: { author: QaQuestion['author']; date: string }) {
  const { t, i18n } = useTranslation();
  return <p className="flex flex-wrap items-center gap-x-2 text-dns-14N-130 text-solid-gray-600">
    <span>{author.name ? (author.source === 'moodle' ? t('qa.moodleParticipant', { id: author.name }) : author.name) : t('qa.deletedUser')}</span>
    {author.instructor && <span className="font-bold text-key-900">{t('qa.instructor')}</span>}
    <time dateTime={date}>{new Date(date).toLocaleDateString(i18n.language)}</time>
  </p>;
}

function PostForm({ title, body, onTitleChange, onBodyChange, onSubmit, onCancel, busy, reply = false }: {
  title?: string; body: string; onTitleChange?: (value: string) => void; onBodyChange: (value: string) => void;
  onSubmit: () => void; onCancel?: () => void; busy: boolean; reply?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  return <form className="space-y-3" onSubmit={(event: FormEvent) => { event.preventDefault(); if (!busy) onSubmit(); }}>
    {onTitleChange && <div className="space-y-1">
      <Label htmlFor={`${id}-title`}>{t('qa.questionTitle')}</Label>
      <Input id={`${id}-title`} value={title ?? ''} onChange={event => onTitleChange(event.target.value)} maxLength={200} required disabled={busy} className="w-full" />
    </div>}
    <div className="space-y-1">
      <Label htmlFor={`${id}-body`}>{t(reply ? 'qa.yourAnswer' : 'qa.questionBody')}</Label>
      <Textarea id={`${id}-body`} value={body} onChange={event => onBodyChange(event.target.value)} maxLength={10000} required disabled={busy} rows={reply ? 4 : 6} className="w-full" />
    </div>
    <p className="text-dns-14N-130 text-solid-gray-600">{t('qa.publishedNotice')}</p>
    <div className="flex flex-wrap gap-2">
      <Button type="submit" size="sm" disabled={busy || !body.trim() || (onTitleChange !== undefined && !title?.trim())}>{t(reply ? 'qa.postAnswer' : 'qa.publish')}</Button>
      {onCancel && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onCancel}>{t('common.actions.cancel')}</Button>}
    </div>
  </form>;
}

function QaSession({ courseId, shareSlug, videoId, videoTitle, active, onVideoPlay }: Props) {
  const { t } = useTranslation();
  const location = useI18nLocation();
  const id = useId();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [currentLecture, setCurrentLecture] = useState(false);
  const [unanswered, setUnanswered] = useState(false);
  const [sort, setSort] = useState<'recent' | 'votes'>('recent');
  const [page, setPage] = useState(0);
  const [replyPage, setReplyPage] = useState(0);
  const [asking, setAsking] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState(false);
  const [editingReply, setEditingReply] = useState<QaReply | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [answer, setAnswer] = useState('');
  const [editedAnswer, setEditedAnswer] = useState('');
  const [error, setError] = useState(false);
  const access = { courseId, ...(shareSlug ? { shareSlug } : {}) };
  const listOptions = trpc.qa.list.queryOptions({ ...access, search, sort, unanswered,
    ...(currentLecture && videoId ? { videoId } : {}), offset: page * 20, limit: 20 });
  const detailOptions = trpc.qa.get.queryOptions({ ...access,
    questionId: selected ?? '00000000-0000-4000-8000-000000000000', offset: replyPage * 20, limit: 20 });
  const list = useQuery({ ...listOptions, enabled: active && !selected });
  const detail = useQuery({ ...detailOptions, enabled: active && !!selected });
  const refresh = () => queryClient.invalidateQueries(trpc.qa.pathFilter());
  const ask = useMutation(trpc.qa.ask.mutationOptions());
  const reply = useMutation(trpc.qa.reply.mutationOptions());
  const updateQuestion = useMutation(trpc.qa.updateQuestion.mutationOptions());
  const deleteQuestion = useMutation(trpc.qa.deleteQuestion.mutationOptions());
  const updateReply = useMutation(trpc.qa.updateReply.mutationOptions());
  const deleteReply = useMutation(trpc.qa.deleteReply.mutationOptions());
  const vote = useMutation(trpc.qa.vote.mutationOptions());
  const feature = useMutation(trpc.qa.feature.mutationOptions());
  const busy = [ask, reply, updateQuestion, deleteQuestion, updateReply, deleteReply, vote, feature].some(mutation => mutation.isPending);
  const canPost = selected ? detail.data?.canPost : list.data?.canPost;
  const canVote = selected ? (detail.data?.canVote ?? detail.data?.canPost) : (list.data?.canVote ?? list.data?.canPost);
  const canModerate = selected ? detail.data?.canModerate : list.data?.canModerate;
  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setError(false);
    try { await operation(); } catch { setError(true); }
  };
  const back = () => { setSelected(null); setReplyPage(0); setEditingQuestion(false); setEditingReply(null); setError(false); };
  const open = (questionId: string) => { setSelected(questionId); setReplyPage(0); setAsking(false); setEditingQuestion(false); setEditingReply(null); setError(false); setAnswer(''); };
  const login = <Link href={`/login?next=${encodeURIComponent(location.pathname)}`} className="text-key-900 underline">{t('qa.loginToPost')}</Link>;
  const voteButton = (question: QaQuestion) => <Button type="button" variant="text" size="sm" disabled={busy || !canVote}
    aria-pressed={question.voted} aria-label={t(question.voted ? 'qa.removeVote' : 'qa.vote')}
    onClick={() => void run(async () => { await vote.mutateAsync({ ...access, questionId: question.id, voted: !question.voted }); await refresh(); })}>
    <ThumbsUp className="h-4 w-4" aria-hidden="true" /><span>{question.votes}</span>
  </Button>;

  const questionActions = (question: QaQuestion) => <div className="flex flex-wrap items-center gap-2">
    {voteButton(question)}
    {question.canEdit && <Button type="button" variant="text" size="sm" disabled={busy} onClick={() => {
      setTitle(question.title); setBody(question.body); setEditingQuestion(true);
    }}>{t('common.actions.edit')}</Button>}
    {canModerate && <Button type="button" variant="text" size="sm" disabled={busy} onClick={() => void run(async () => {
      await feature.mutateAsync({ ...access, questionId: question.id, featured: !question.featured }); await refresh();
    })}><Pin className="h-4 w-4" aria-hidden="true" />{t(question.featured ? 'qa.unfeature' : 'qa.feature')}</Button>}
    {question.canDelete && <Button type="button" variant="text" size="sm" className="text-error-1" disabled={busy} onClick={() => void run(async () => {
      if (!await confirm({ title: t('qa.deleteQuestion'), description: t('qa.deleteQuestionConfirm'), confirmLabel: t('common.actions.delete'), variant: 'danger' })) return;
      await deleteQuestion.mutateAsync({ ...access, questionId: question.id }); back(); setPage(0); await refresh();
    })}>{t('qa.deleteQuestion')}</Button>}
  </div>;

  return <div className="space-y-5 py-4 text-solid-gray-800">
    {error && <p role="alert" className="text-error-1">{t('qa.operationError')}</p>}
    {selected ? <>
      <Button type="button" variant="text" size="sm" disabled={busy} onClick={back}><ArrowLeft className="h-4 w-4" aria-hidden="true" />{t('qa.back')}</Button>
      {detail.isPending ? <p role="status">{t('qa.loading')}</p> : detail.isError ? <div role="alert">
        <p>{t('qa.loadError')}</p><Button type="button" variant="outline" size="sm" onClick={() => void detail.refetch()}>{t('chat.retry')}</Button>
      </div> : detail.data && <>
        {editingQuestion ? <PostForm title={title} body={body} onTitleChange={setTitle} onBodyChange={setBody} busy={busy}
          onCancel={() => setEditingQuestion(false)} onSubmit={() => void run(async () => {
            await updateQuestion.mutateAsync({ ...access, questionId: selected, title, body }); setEditingQuestion(false); await refresh();
          })} /> : <section className="space-y-3">
          {detail.data.question.featured && <p className="flex items-center gap-1 text-dns-14B-130 text-key-900"><Pin className="h-4 w-4" aria-hidden="true" />{t('qa.featured')}</p>}
          <h3 className="break-words text-std-20B-150">{detail.data.question.title}</h3>
          <Author author={detail.data.question.author} date={detail.data.question.createdAt} />
          <p className="whitespace-pre-wrap break-words text-std-16N-170">{detail.data.question.body}</p>
          {detail.data.question.videoId && <Button type="button" variant="text" size="sm" onClick={() => onVideoPlay(detail.data.question.videoId!, '00:00:00')}>{detail.data.question.videoTitle}</Button>}
          {questionActions(detail.data.question)}
        </section>}
        <section className="space-y-4 border-t border-solid-gray-300 pt-4" aria-label={t('qa.answers')}>
          <h3 className="text-std-18B-160">{t('qa.answerCount', { count: detail.data.replyTotal })}</h3>
          {detail.data.replies.length === 0 && <p className="text-solid-gray-600">{t('qa.noAnswers')}</p>}
          {detail.data.replies.map(item => <article key={item.id} className="space-y-2 border-b border-solid-gray-200 pb-4">
            <Author author={item.author} date={item.createdAt} />
            {editingReply?.id === item.id ? <PostForm body={editedAnswer} onBodyChange={setEditedAnswer} busy={busy} reply
              onCancel={() => setEditingReply(null)} onSubmit={() => void run(async () => {
                await updateReply.mutateAsync({ ...access, questionId: selected, replyId: item.id, body: editedAnswer }); setEditingReply(null); await refresh();
              })} /> : <>
              <p className="whitespace-pre-wrap break-words text-std-16N-170">{item.body}</p>
              <div className="flex gap-2">
                {item.canEdit && <Button type="button" variant="text" size="sm" disabled={busy} onClick={() => { setEditingReply(item); setEditedAnswer(item.body); }}>{t('qa.editAnswer')}</Button>}
                {item.canDelete && <Button type="button" variant="text" size="sm" className="text-error-1" disabled={busy} onClick={() => void run(async () => {
                  if (!await confirm({ title: t('qa.deleteAnswer'), confirmLabel: t('common.actions.delete'), variant: 'danger' })) return;
                  await deleteReply.mutateAsync({ ...access, questionId: selected, replyId: item.id }); await refresh();
                })}>{t('qa.deleteAnswer')}</Button>}
              </div>
            </>}
          </article>)}
          {detail.data.replyTotal > 20 && <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" disabled={replyPage === 0 || busy || detail.isFetching} onClick={() => setReplyPage(value => value - 1)}>{t('qa.previous')}</Button>
            <span>{replyPage + 1} / {Math.ceil(detail.data.replyTotal / 20)}</span>
            <Button type="button" size="sm" variant="outline" disabled={(replyPage + 1) * 20 >= detail.data.replyTotal || busy || detail.isFetching} onClick={() => setReplyPage(value => value + 1)}>{t('qa.next')}</Button>
          </div>}
        </section>
        {canPost ? <PostForm body={answer} onBodyChange={setAnswer} busy={busy} reply onSubmit={() => void run(async () => {
          await reply.mutateAsync({ ...access, questionId: selected, body: answer }); setAnswer(''); setReplyPage(Math.floor(detail.data.replyTotal / 20)); await refresh();
        })} /> : login}
      </>}
    </> : <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-std-20B-150">{t('qa.questionCount', { count: list.data?.total ?? 0 })}</h3>
        {canPost && !asking && <Button type="button" size="sm" onClick={() => { setAsking(true); setTitle(''); setBody(''); setError(false); }}>{t('qa.ask')}</Button>}
      </div>
      {asking ? <section className="space-y-3">
        <h3 className="text-std-18B-160">{t('qa.ask')}</h3>
        {videoTitle && <p className="text-solid-gray-600">{t('qa.aboutLecture', { title: videoTitle })}</p>}
        <PostForm title={title} body={body} onTitleChange={setTitle} onBodyChange={setBody} busy={busy} onCancel={() => setAsking(false)}
          onSubmit={() => void run(async () => {
            const question = await ask.mutateAsync({ ...access, title, body, videoId: videoId ?? null });
            setAsking(false); setTitle(''); setBody(''); open(question.id); await refresh();
          })} />
      </section> : <>
        <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); setSearch(searchText.trim()); setPage(0); }}>
          <div className="min-w-0 flex-1 space-y-1"><Label htmlFor={`${id}-search`}>{t('qa.search')}</Label><Input id={`${id}-search`} type="search" value={searchText} maxLength={200} onChange={event => setSearchText(event.target.value)} className="w-full" /></div>
          <Button type="submit" variant="outline" size="sm">{t('qa.searchButton')}</Button>
        </form>
        <div className="flex flex-wrap items-center gap-4">
          {videoId && <label className="flex items-center gap-2 text-dns-14N-130"><Checkbox checked={currentLecture} onCheckedChange={value => { setCurrentLecture(value === true); setPage(0); }} />{t('qa.currentLecture')}</label>}
          <label className="flex items-center gap-2 text-dns-14N-130"><Checkbox checked={unanswered} onCheckedChange={value => { setUnanswered(value === true); setPage(0); }} />{t('qa.unanswered')}</label>
          <Select value={sort} onValueChange={value => { if (value === 'recent' || value === 'votes') { setSort(value); setPage(0); } }}>
            <SelectTrigger blockSize="sm" aria-label={t('qa.sort')}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="recent">{t('qa.recent')}</SelectItem><SelectItem value="votes">{t('qa.mostVotes')}</SelectItem></SelectContent>
          </Select>
        </div>
        {list.isPending ? <p role="status">{t('qa.loading')}</p> : list.isError ? <div role="alert"><p>{t('qa.loadError')}</p><Button type="button" variant="outline" size="sm" onClick={() => void list.refetch()}>{t('chat.retry')}</Button></div> : <>
          {list.data.items.length === 0 && <p className="py-6 text-solid-gray-600">{t(search || currentLecture || unanswered ? 'qa.noMatches' : 'qa.empty')}</p>}
          <div className="divide-y divide-solid-gray-200">
            {list.data.items.map(question => <article key={question.id} className="space-y-2 py-4">
              {question.featured && <p className="flex items-center gap-1 text-dns-14B-130 text-key-900"><Pin className="h-4 w-4" aria-hidden="true" />{t('qa.featured')}</p>}
              <h4><button type="button" onClick={() => open(question.id)} className="break-words text-left text-std-18B-160 text-key-900 underline focus-visible:outline-4 focus-visible:outline-black">{question.title}</button></h4>
              <p className="line-clamp-2 break-words text-std-16N-170 text-solid-gray-700">{question.body}</p>
              <Author author={question.author} date={question.createdAt} />
              <div className="flex flex-wrap items-center gap-2 text-dns-14N-130 text-solid-gray-600">{voteButton(question)}<MessageCircle className="h-4 w-4" aria-hidden="true" />{t('qa.answerCount', { count: question.replyCount })}{question.videoTitle && <span>· {question.videoTitle}</span>}</div>
            </article>)}
          </div>
          {list.data.total > 20 && <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={page === 0 || list.isFetching} onClick={() => setPage(value => value - 1)}>{t('qa.previous')}</Button>
            <span>{page + 1} / {Math.ceil(list.data.total / 20)}</span>
            <Button type="button" variant="outline" size="sm" disabled={(page + 1) * 20 >= list.data.total || list.isFetching} onClick={() => setPage(value => value + 1)}>{t('qa.next')}</Button>
          </div>}
          {!canPost && login}
        </>}
      </>}
    </>}
  </div>;
}
