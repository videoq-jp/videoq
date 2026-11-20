import { LANDING_AUDIENCES, type LandingAudience, type LandingAcquisition } from './landing-events';

export interface LandingParameters { get(name: string): string | null; keys(): IterableIterator<string> }

export function classifyLandingAudience(params: LandingParameters, referrerHost: () => string | null): LandingAudience {
  const value = LANDING_AUDIENCES.find(audience => audience === params.get('audience'));
  if (value) return value;
  // Instructor ads default to the online-course audience; historic student and
  // teacher cohorts keep their classification. Untagged visits are general.
  const acquisition = classifyLandingAcquisition(params, referrerHost);
  if (acquisition === 'x_paid_instructor_ja' || acquisition === 'x_paid_instructor_en') return 'creator';
  if (['x_paid_demo15_search', 'x_paid_student_ja', 'x_paid_student_en'].includes(acquisition)) return 'student';
  return acquisition === 'x_paid_teacher_qa' ? 'school' : 'general';
}

function searchReferral(params: LandingParameters, referrerHost: () => string | null): LandingAcquisition {
  if ([...params.keys()].some(key => key.startsWith('utm_') || ['gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid'].includes(key))) return 'unattributed';
  const host = referrerHost();
  return host !== null && ['google.com', 'www.google.com', 'google.co.jp', 'www.google.co.jp',
    'bing.com', 'www.bing.com', 'search.yahoo.co.jp', 'search.yahoo.com',
    'duckduckgo.com', 'www.duckduckgo.com'].includes(host) ? 'search_referral' : 'unattributed';
}

export function classifyLandingAcquisition(params: LandingParameters, referrerHost: () => string | null): LandingAcquisition {
  if (params.get('measurement') === 'test') return 'internal_test';
  if (params.get('utm_source') !== 'x') return searchReferral(params, referrerHost);
  if (params.get('utm_medium') === 'paid_social'
    && params.get('utm_campaign') === 'student_demo_test'
    && params.get('utm_content') === 'demo15_search') return 'x_paid_demo15_search';
  if (params.get('utm_medium') === 'paid_social'
    && params.get('utm_campaign') === 'teacher_qa_test'
    && params.get('utm_content') === 'lecture_qa') return 'x_paid_teacher_qa';
  if (params.get('utm_medium') === 'paid_social'
    && params.get('utm_campaign') === 'student_return_202610') {
    if (params.get('utm_content') === 'demo15_search_ja') return 'x_paid_student_ja';
    if (params.get('utm_content') === 'demo15_search_en') return 'x_paid_student_en';
  }
  if (params.get('utm_medium') === 'paid_social'
    && params.get('utm_campaign') === 'instructor_202611') {
    if (params.get('utm_content') === 'demo30_ja') return 'x_paid_instructor_ja';
    if (params.get('utm_content') === 'demo30_en') return 'x_paid_instructor_en';
  }
  if (params.get('utm_medium') === 'organic_social'
    && params.get('utm_campaign') === 'launch'
    && ['intro', 'howto', 'usecase'].includes(params.get('utm_content') ?? '')) return 'x_organic_launch';
  return 'unattributed';
}

