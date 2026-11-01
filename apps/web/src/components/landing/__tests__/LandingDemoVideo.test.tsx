import { fireEvent, render, screen } from '@testing-library/react';
import { LandingDemoVideo } from '../LandingDemoVideo';

describe('LandingDemoVideo',()=>{
  beforeEach(()=>{
    globalThis.__setMockLanguage('ja');
    vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});
  });
  afterEach(()=>vi.restoreAllMocks());
  it('waits for an explicit play and then exposes native controls',()=>{
    const {container}=render(<LandingDemoVideo/>);
    const video=container.querySelector('video')!;
    expect(video).toHaveAttribute('src','/demo/provider-demo-ja.mp4?v=4');
    expect(video.parentElement).toHaveStyle({aspectRatio:'16 / 9'});
    expect(video).toHaveAttribute('preload','none');
    expect(video.autoplay).toBe(false);
    expect(video.play).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'landing.film.play'}));
    expect(video.play).toHaveBeenCalledOnce();
    fireEvent.play(video);
    expect(video.controls).toBe(true);
    expect(screen.queryByRole('button',{name:'landing.film.play'})).not.toBeInTheDocument();
  });
  it('allows retrying a failed media request',()=>{
    const {container}=render(<LandingDemoVideo/>);
    const video=container.querySelector('video')!;
    fireEvent.error(video);
    expect(screen.getByRole('status')).toHaveTextContent('landing.film.error');
    fireEvent.click(screen.getByRole('button',{name:'landing.film.retry'}));
    expect(video.load).toHaveBeenCalledOnce();
    expect(screen.getByRole('button',{name:'landing.film.play'})).toBeInTheDocument();
  });
  it('resets playback when switching to the English edit',()=>{
    const {container,rerender}=render(<LandingDemoVideo/>);
    fireEvent.play(container.querySelector('video')!);
    globalThis.__setMockLanguage('en');rerender(<LandingDemoVideo/>);
    const video=container.querySelector('video')!;
    expect(video).toHaveAttribute('src','/demo/provider-demo-en.mp4?v=4');
    expect(video).toHaveAttribute('poster','/demo/provider-demo-en-poster.webp?v=4');
    expect(video.parentElement).toHaveStyle({aspectRatio:'16 / 9'});
    expect(container.querySelector('track')).toHaveAttribute('src','/demo/provider-demo-en.vtt?v=4');
    expect(container.querySelector('track')).toHaveAttribute('srcLang','en');
    expect(screen.getByRole('button',{name:'landing.film.play'})).toBeInTheDocument();
  });
});
