import { classifyLandingAudience, classifyLandingAcquisition } from '../application/landing-attribution';
import { features } from "./deployment";
import { LANDING_ACQUISITIONS, LANDING_AUDIENCES, LANDING_EVENTS, type LandingAcquisition, type LandingAudience, type LandingEvent, type LandingEventPayload, type LandingPlacement } from './landingEvents';

const STORAGE_KEY = 'videoq.landing.student-v1';
const VISIT_TTL = 30 * 60_000;
type Visit = { audience: LandingAudience; acquisition: LandingAcquisition; seen: LandingEvent[]; updated: number };

function referrerHost(): string | null {
  try {
    const referrer = new URL(document.referrer);
    return referrer.protocol === 'https:' || referrer.protocol === 'http:' ? referrer.hostname : null;
  } catch { return null; }
}

export function getLandingAudience(search = window.location.search): LandingAudience {
  return classifyLandingAudience(new URLSearchParams(search), referrerHost);
}

export function getLandingAcquisition(search = window.location.search): LandingAcquisition {
  return classifyLandingAcquisition(new URLSearchParams(search), referrerHost);
}

function enabled() {
  if (!features.marketing) return false;
  const privacy = navigator as Navigator & { globalPrivacyControl?: boolean };
  return import.meta.env.PROD && window.location.hostname === 'videoq.jp'
    && navigator.doNotTrack !== '1' && privacy.globalPrivacyControl !== true;
}

function readVisit(): Visit | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const data = JSON.parse(raw) as Partial<Visit>;
  if (!data || !Array.isArray(data.seen) || !data.seen.every(item => LANDING_EVENTS.includes(item))
    || typeof data.updated !== 'number' || Date.now() - data.updated > VISIT_TTL
    || !LANDING_AUDIENCES.some(audience => audience === data.audience)) return null;
  const acquisition = LANDING_ACQUISITIONS.find(source => source === data.acquisition) ?? 'unattributed';
  return { audience: data.audience!, acquisition, seen: data.seen, updated: data.updated };
}

export function startLandingVisit() {
  if (!enabled()) return;
  try {
    const visit = readVisit();
    const acquisition = getLandingAcquisition();
    if (!visit || (acquisition === 'internal_test' && visit.acquisition !== 'internal_test')) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        audience: getLandingAudience(), acquisition, seen: [], updated: Date.now(),
      }));
    }
    trackLandingEvent('landing_view');
  } catch { /* Storage may be blocked; the product remains usable. */ }
}

/** Called from a signup callback after confirming the relevant auth session. */
export function completeSignupTracking(method: 'google' | 'email') {
  if (!enabled()) return;
  try {
    // An ordinary login or a direct visit to the completion page is not a signup.
    const started = method === 'google' ? 'google_auth_started' : 'email_signup_created';
    if (!readVisit()?.seen.includes(started)) return;
    trackLandingEvent(method === 'google' ? 'google_signup_created' : 'email_verified');
  } catch { /* Analytics must not prevent the post-signup redirect. */ }
}

export function trackLandingEvent(event: LandingEvent, placement: LandingPlacement = 'none') {
  if (!features.marketing) return;
  if (!enabled()) return;
  try {
    const visit = readVisit();
    if (!visit || visit.seen.includes(event)) return;
    const payload: LandingEventPayload = {
      event, placement, audience: visit.audience, acquisition: visit.acquisition,
      locale: /^\/en(?:\/|$)/.test(window.location.pathname) ? 'en' : 'ja',
    };
    // Once per stage per tab visit, including React StrictMode and repeated clicks.
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...visit, seen: [...visit.seen, event], updated: Date.now() }));
    void fetch('/__events/landing', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), keepalive: true, credentials: 'omit', referrerPolicy: 'no-referrer',
    }).catch(() => { /* Best-effort measurement must never interrupt navigation. */ });
  } catch { /* No analytics failure may affect signup, playback, or chat. */ }
}
