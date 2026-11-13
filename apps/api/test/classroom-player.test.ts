import { createContext, Script } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { playerScript } from '../src/features/classroom/view';
function harness(fetch: typeof globalThis.fetch) {
  const media = { hidden: true, src: '', readyState: 1, duration: 60, currentTime: 0,
    pause: vi.fn(), play: vi.fn(async () => {}), removeAttribute: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const youtube = { hidden: true, src: '', removeAttribute: vi.fn() };
  const select = { value: '1' }, status = { textContent: '' };
  const elements = { 'classroom-media': media, 'classroom-youtube': youtube, 'classroom-video': select, 'classroom-player-status': status };
  const context = createContext({ document: { getElementById: (id: keyof typeof elements) => elements[id] }, fetch,
    token: 'session', playback: null, performance, URL, setTimeout, clearTimeout,
    sourceSeconds: () => 12 });
  new Script(playerScript + '\nglobalThis.player={load:classroomLoad,seek:classroomSeek};').runInContext(context);
  const player = context.player as { load: (id: number) => Promise<boolean>; seek: (source: { video_id: number; start_time: string }) => Promise<void> };
  return { player, media, youtube, status };
}
it('keeps the latest selected video when older playback requests finish later', async () => {
  let finishFirst!: (response: Response) => void;
  const firstResponse = new Promise<Response>(resolve => { finishFirst = resolve; });
  const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValueOnce(firstResponse)
    .mockResolvedValueOnce(Response.json({ kind: 'file', url: 'https://media.example/new.mp4' }));
  const { player, media } = harness(fetch);
  const first = player.load(1), second = player.load(2);
  expect(await second).toBe(true);finishFirst(Response.json({ kind: 'file', url: 'https://media.example/old.mp4' }));
  expect(await first).toBe(false);expect(media.src).toBe('https://media.example/new.mp4');
});
it('does not seek a video whose selection was superseded during loading', async () => {
  let finishFirst!: (response: Response) => void;
  const firstResponse = new Promise<Response>(resolve => { finishFirst = resolve; });
  const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValueOnce(firstResponse)
    .mockResolvedValueOnce(Response.json({ kind: 'file', url: 'https://media.example/new.mp4' }));
  const { player, media } = harness(fetch);
  const seeking = player.seek({ video_id: 1, start_time: '00:00:12' });
  await player.load(2);finishFirst(Response.json({ kind: 'file', url: 'https://media.example/old.mp4' }));
  await seeking;expect(media.currentTime).toBe(0);expect(media.play).not.toHaveBeenCalled();
});
it('ignores a stale network failure after a newer video is ready', async () => {
  let failFirst!: (reason: Error) => void;
  const firstResponse = new Promise<Response>((_resolve, reject) => { failFirst = reject; });
  const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValueOnce(firstResponse)
    .mockResolvedValueOnce(Response.json({ kind: 'file', url: 'https://media.example/new.mp4' }));
  const { player, status } = harness(fetch);
  const first = player.load(1);await player.load(2);failFirst(new Error('Old request failed'));
  expect(await first).toBe(false);expect(status.textContent).toBe('');
});
