import { act, renderHook } from '@testing-library/react';
import { useViewerViewport } from '../useViewerViewport';

class Viewport extends EventTarget {
  height = 844;
  scale = 1;
  resize(height: number, scale = this.scale) {
    this.height = height;
    this.scale = scale;
    this.dispatchEvent(new Event('resize'));
  }
}

afterEach(() => vi.unstubAllGlobals());

it('follows the visible height as a keyboard opens, rotates and closes', () => {
  const viewport = new Viewport();
  vi.stubGlobal('visualViewport', viewport);
  const { result } = renderHook(() => useViewerViewport());
  expect(result.current).toBe(844);
  act(() => viewport.resize(460));
  expect(result.current).toBe(460);
  act(() => viewport.resize(320));
  expect(result.current).toBe(320);
  act(() => viewport.resize(844));
  expect(result.current).toBe(844);
});

it('uses CSS viewport sizing during pinch zoom and resumes tracking at normal scale', () => {
  const viewport = new Viewport();
  vi.stubGlobal('visualViewport', viewport);
  const { result } = renderHook(() => useViewerViewport());
  act(() => viewport.resize(422, 2));
  expect(result.current).toBeUndefined();
  act(() => viewport.resize(844, 1));
  expect(result.current).toBe(844);
});

it('falls back to CSS sizing when VisualViewport is unavailable', () => {
  vi.stubGlobal('visualViewport', undefined);
  const { result } = renderHook(() => useViewerViewport());
  expect(result.current).toBeUndefined();
});

it('releases its resize subscription on unmount', () => {
  const viewport = new Viewport();
  const add = vi.spyOn(viewport, 'addEventListener');
  const remove = vi.spyOn(viewport, 'removeEventListener');
  vi.stubGlobal('visualViewport', viewport);
  const { unmount } = renderHook(() => useViewerViewport());
  const listener = add.mock.calls[0][1];
  expect(add).toHaveBeenCalledExactlyOnceWith('resize', listener);
  unmount();
  expect(remove).toHaveBeenCalledExactlyOnceWith('resize', listener);
  vi.restoreAllMocks();
});
