import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { AuthPageIntro } from '@/components/layout/AuthPageIntro';
import { Button } from '@/components/ui/button';
import { API_URL } from '@/lib/apiConfig';
import { useAuthSession } from '@/lib/authSession';
import { useI18nNavigate } from '@/lib/i18n';
type Review = { provider: 'moodle' | 'classroom'; title: string; teacherName: string; contextId: string; courses: { id: number; name: string }[] };
function ConnectionReview({ ticket, userId, email }: { ticket: string; userId: string; email: string }) {
  const [selected, setSelected] = useState(''), [error, setError] = useState('');
  const [pending, setPending] = useState(false), [done, setDone] = useState(false);
  const query = useQuery({ queryKey: ['teaching-review', ticket, userId], retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch(API_URL.replace(/\/+$/, '') + '/teaching/review', { method: 'POST', credentials: 'include', signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
      if (!response.ok) throw new Error('接続を確認できません。授業画面からやり直してください。');
      return await response.json() as Review;
    } });
  const review = query.data, courseId = selected || String(review?.courses[0]?.id ?? '');
  async function connect() {
    if (!review || pending) return;setPending(true);setError('');
    try {
      const response = await fetch(API_URL.replace(/\/+$/, '') + '/teaching/connect', { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket, courseId: Number(courseId) }) });
      if (!response.ok) throw new Error(response.status === 409 ? 'このクラスはすでに接続されています。接続した先生に確認してください。' : '接続できません。授業画面からやり直してください。');
      setDone(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '接続できません。'); } finally { setPending(false); }
  }
  if (done) return <p role="status">接続しました。元の授業画面に戻って更新してください。</p>;
  if (query.isPending) return <p role="status">確認しています…</p>;
  if (query.error) return <p role="alert">{query.error.message}</p>;
  if (!review) return null;
  return <div className="space-y-5">
    {error && <p role="alert">{error}</p>}
    <p>{review.provider === 'moodle' ? 'Moodle' : 'Google Classroom'}：{review.title}</p>
    <p>授業側のアカウント：{review.teacherName}</p>
    <p>接続先のVideoQアカウント：{email}</p>
    <label className="block">利用する講座
      <select className="block w-full border rounded p-3 mt-2" value={courseId} onChange={event => setSelected(event.target.value)}>
        {review.courses.map(course => <option key={course.id} value={course.id}>{course.name}</option>)}
      </select>{!review.courses.length && <p>先にVideoQで講座を作成してください。</p>}
    </label>
    <p>教材と質問履歴はこのアカウントで管理し、AI・動画処理・保存容量もこのアカウントの利用枠を使用します。</p>
    <Button disabled={pending || !courseId} onClick={() => void connect()}>{pending ? '接続しています…' : 'このアカウントで接続'}</Button>
  </div>;
}
export default function TeachingConnectPage() {
  const session = useAuthSession(), navigate = useI18nNavigate(), location = useLocation();
  const params = new URLSearchParams(location.search), ticket = params.get('ticket');
  const valid = params.size === 1 && !!ticket && /^[a-f0-9]{64}$/.test(ticket);
  const user = session.data?.user;
  return <>
    <AuthPageIntro badge="VideoQ" title="担当クラスをVideoQに接続" />
    {!valid ? <p role="alert">授業画面から接続を開始してください。</p>
      : session.isPending ? <p role="status">確認しています…</p>
      : !user ? <Button onClick={() => navigate('/login?next=' + encodeURIComponent(location.pathname + location.search))}>VideoQにログイン</Button>
      : <ConnectionReview key={ticket + ':' + user.id} ticket={ticket} userId={user.id} email={user.email} />}
  </>;
}
