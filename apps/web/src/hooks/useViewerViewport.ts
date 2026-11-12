import { useEffect, useState } from 'react';

/** Follow the visible viewport when a phone keyboard covers the layout viewport. */
export function useViewerViewport() {
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setHeight(viewport.scale === 1 ? viewport.height : undefined);
    update();
    viewport.addEventListener('resize', update);
    return () => viewport.removeEventListener('resize', update);
  }, []);
  return height;
}
