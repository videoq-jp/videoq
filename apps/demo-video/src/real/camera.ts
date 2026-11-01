import type { Point } from '../StudentDemo';
import type { Locale } from './film';

// Centres of the real controls, measured in the product viewport.
const targets = {
  ja: { share: { x: 1306, y: 154 }, citation: { x: 1386, y: 590 }, history: { x: 1523, y: 219 } },
  en: { share: { x: 1280, y: 154 }, citation: { x: 1378, y: 590 }, history: { x: 1481, y: 219 } },
};
const uploadButton = { x: 980, y: 729 };
const copyButton = { x: 550, y: 627 };
const lesson = { x: 209, y: 368 };
const input = { x: 1391, y: 741 };
const send = { x: 1533, y: 741 };

// Times are seconds into each scene; every move settles before its click.
export function cameraFor(_locale: Locale): Record<'upload' | 'share' | 'student' | 'history', Point[]> {
  return {
    upload: [{ f: 0, x: 800, y: 401, z: 1 }, { f: .5, x: 800, y: 401, z: 1 }, { f: 1, x: 800, y: 520, z: 1.25 }, { f: 3.3, x: 800, y: 520, z: 1.25 }],
    share: [
      { f: 3.3, x: 800, y: 401, z: 1 }, { f: 3.5, x: 800, y: 401, z: 1 },
      { f: 3.9, x: 1250, y: 200, z: 1.5 }, { f: 4.3, x: 1250, y: 200, z: 1.5 },
      { f: 4.75, x: 800, y: 430, z: 1.2 }, { f: 7, x: 800, y: 430, z: 1.2 },
    ],
    student: [
      { f: 0, x: 800, y: 401, z: 1 }, { f: .55, x: 800, y: 401, z: 1 },
      { f: .9, x: 330, y: 390, z: 1.35 }, { f: 1.3, x: 330, y: 390, z: 1.35 },
      { f: 1.8, x: 1320, y: 640, z: 1.7 }, { f: 4.1, x: 1320, y: 640, z: 1.7 },
      { f: 4.6, x: 1320, y: 500, z: 1.9 }, { f: 8.8, x: 1320, y: 500, z: 1.9 },
      { f: 9.1, x: 1320, y: 540, z: 1.8 }, { f: 9.55, x: 1320, y: 540, z: 1.8 },
      { f: 10, x: 760, y: 500, z: 1.4 }, { f: 13, x: 760, y: 500, z: 1.4 },
    ],
    history: [
      { f: 0, x: 800, y: 401, z: 1 }, { f: .35, x: 800, y: 401, z: 1 },
      { f: .85, x: 1380, y: 420, z: 1.75 }, { f: 4, x: 1380, y: 420, z: 1.75 },
    ],
  };
}

export function cursorFor(locale: Locale): Record<'upload' | 'share' | 'student' | 'history', Point[]> {
  const { share, citation, history } = targets[locale];
  return {
    upload: [{ f: 0, x: 860, y: 600 }, { f: .1, x: 860, y: 600 }, { f: .45, ...uploadButton }, { f: 3.3, ...uploadButton }],
    share: [{ f: 3.3, x: 800, y: 500 }, { f: 3.55, x: 800, y: 500 }, { f: 4.1, ...share }, { f: 4.3, ...share }, { f: 5.45, ...copyButton }, { f: 7, ...copyButton }],
    student: [
      { f: 0, x: 800, y: 620 }, { f: .55, x: 800, y: 620 }, { f: .95, ...lesson },
      { f: 1.35, ...lesson }, { f: 1.85, ...input }, { f: 3.65, ...input },
      { f: 3.9, ...send }, { f: 4.05, ...send }, { f: 4.35, x: 1500, y: 660 },
      { f: 8.9, x: 1500, y: 660 }, { f: 9.25, ...citation }, { f: 9.6, ...citation },
      { f: 9.95, x: 900, y: 610 }, { f: 13, x: 900, y: 610 },
    ],
    history: [{ f: 0, x: 800, y: 500 }, { f: .35, x: 800, y: 500 }, { f: .9, ...history }, { f: 1.3, ...history }, { f: 1.9, x: 1250, y: 720 }, { f: 4, x: 1250, y: 720 }],
  };
}
