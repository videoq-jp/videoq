import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ViewerPlayerFrame } from '../ViewerPlayerFrame';

it('collapses and reopens playback without replacing the video or losing its position', () => {
  function Player() {
    const [expanded, setExpanded] = useState(true);
    return <ViewerPlayerFrame title="Matrices" expanded={expanded} onExpandedChange={setExpanded}>
      <video aria-label="Lecture video" src="/lesson.mp4" />
    </ViewerPlayerFrame>;
  }
  const { container } = render(<Player />);
  const video = container.querySelector('video')!;
  video.currentTime = 37;
  const collapse = screen.getByRole('button', { name: 'videos.shared.hidePlayer' });
  const controls = collapse.getAttribute('aria-controls');
  expect(document.getElementById(controls!)).toContainElement(video);
  fireEvent.click(collapse);
  const reopen = screen.getByRole('button', { name: 'videos.shared.showPlayer' });
  expect(reopen).toHaveAttribute('aria-expanded', 'false');
  expect(reopen).toHaveAttribute('aria-controls', controls);
  expect(container.querySelector('video')).toBe(video);
  expect(video.currentTime).toBe(37);
  fireEvent.click(reopen);
  expect(screen.getByRole('button', { name: 'videos.shared.hidePlayer' })).toHaveAttribute('aria-expanded', 'true');
  expect(container.querySelector('video')).toBe(video);
  expect(video.currentTime).toBe(37);
});
