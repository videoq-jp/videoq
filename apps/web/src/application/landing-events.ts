// Shared with the collector. No free-text, URLs, identifiers, or ad query strings.
export const LANDING_EVENTS = [
  'landing_view', 'demo_open', 'demo_engaged', 'demo_complete', 'demo_question', 'demo_source', 'sample_download',
  'signup_click', 'signup_view', 'email_signup_created', 'email_verified', 'first_answer',
  'google_auth_started', 'google_signup_created',
  'video_upload_started', 'video_upload_accepted', 'video_upload_failed',
  'course_share_created', 'course_invite_queued',
] as const;
// `creator` is the instructor landing page's online-course audience; `student` is kept for historic cohorts.
export const LANDING_AUDIENCES = ['general', 'creator', 'school', 'training', 'student'] as const;
export const LANDING_PLACEMENTS = ['none', 'hero', 'free', 'footer', 'mobile', 'header'] as const;
// Fixed cohorts only; never accept or log arbitrary UTM values.
export const LANDING_ACQUISITIONS = ['unattributed', 'search_referral', 'x_paid_demo15_search', 'x_paid_teacher_qa', 'x_paid_student_ja', 'x_paid_student_en', 'x_paid_instructor_ja', 'x_paid_instructor_en', 'x_organic_launch', 'internal_test'] as const;
export type LandingEvent = (typeof LANDING_EVENTS)[number];
export type LandingAudience = (typeof LANDING_AUDIENCES)[number];
export type LandingPlacement = (typeof LANDING_PLACEMENTS)[number];
export type LandingAcquisition = (typeof LANDING_ACQUISITIONS)[number];
export type LandingEventPayload = {
  event: LandingEvent;
  audience: LandingAudience;
  locale: 'ja' | 'en';
  placement: LandingPlacement;
  acquisition?: LandingAcquisition;
};

export function isLandingEventPayload(value: unknown): value is LandingEventPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const validAcquisition = Object.keys(data).length === 4 && !('acquisition' in data)
    || Object.keys(data).length === 5 && LANDING_ACQUISITIONS.some(source => source === data.acquisition);
  return validAcquisition
    && LANDING_EVENTS.some(event => event === data.event)
    && LANDING_AUDIENCES.some(audience => audience === data.audience)
    && LANDING_PLACEMENTS.some(placement => placement === data.placement)
    && (data.locale === 'ja' || data.locale === 'en');
}
