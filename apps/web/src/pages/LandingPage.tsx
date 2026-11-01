import { useEffect, useState } from 'react';
import { ArrowDown, ArrowRight, BarChart3, BookOpen, Briefcase, Check, ChevronDown, FileText, GraduationCap, Link2, MessageCircle, MonitorPlay, Play, School, Search, Sparkles, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useLocale } from '@/lib/i18n';
import { StructuredData } from '@/components/seo/StructuredData';
import { homeStructuredData } from '@/lib/structuredData';
import { LandingDemoVideo } from '@/components/landing/LandingDemoVideo';
import { LandingFreePlan } from '@/components/landing/LandingFreePlan';
import { startLandingVisit, trackLandingEvent } from '@/lib/landingAnalytics';
import '@/styles/landing.css';

const CAPABILITIES = [
  { key: 'create', icon: FileText },
  { key: 'source', icon: Play },
  { key: 'share', icon: Link2 },
  { key: 'insights', icon: BarChart3 },
] as const;
const BENEFITS = [
  { key: 'answer', icon: MessageCircle },
  { key: 'source', icon: Play },
  { key: 'share', icon: Link2 },
  { key: 'insights', icon: BarChart3 },
] as const;
const COMPARE_ROWS = ['basis', 'source', 'teacher'] as const;
const USES = [
  { key: 'courses', icon: MonitorPlay },
  { key: 'schools', icon: School },
  { key: 'training', icon: Briefcase },
] as const;
const STEPS = [
  { key: 'upload', icon: Upload },
  { key: 'course', icon: BookOpen },
  { key: 'share', icon: Link2 },
] as const;
const FAQ_KEYS = ['free', 'accounts', 'cost', 'accuracy', 'history'] as const;
const INSIGHT_BARS = [38, 62, 45, 80, 56] as const;

export default function LandingPage() {
  const { t } = useTranslation();
  const locale = useLocale();
  const [activeUse, setActiveUse] = useState<(typeof USES)[number]['key']>('courses');
  useEffect(() => { startLandingVisit(); }, []);

  return (
    <div className="landing">
      <StructuredData data={homeStructuredData(locale, t('site.description'), t('landing.film.title'))} />
      <section className="lp-hero" aria-labelledby="landing-title">
        <div className="lp-hero-copy">
          <p className="lp-eyebrow"><span className="lp-status-dot" />{t('landing.badge')}</p>
          <h1 id="landing-title">
            {t('landing.title')}<br />
            <span>{t('landing.titleAccent')}</span>
          </h1>
          <p className="lp-lead">{t('landing.lead')}</p>
          <div className="lp-hero-actions">
            <Link href="/signup" className="lp-button lp-button-primary" onClick={() => trackLandingEvent('signup_click', 'hero')}>
              {t('landing.start')}<ArrowRight size={18} aria-hidden="true" />
            </Link>
            <Link href="/try" className="lp-button lp-button-secondary" onClick={() => trackLandingEvent('demo_open', 'hero')}>
              <MessageCircle size={16} aria-hidden="true" />{t('landing.tryDemo')}
            </Link>
          </div>
          <p className="lp-reassurance"><Check size={15} aria-hidden="true" />{t('landing.startNote')}</p>
        </div>
        <div className="lp-demo-wrap">
          <LandingDemoVideo />
        </div>
      </section>

      <div className="lp-capabilities" aria-label={t('landing.capabilities.title')}>
        {CAPABILITIES.map(({ key, icon: Icon }) => (
          <span key={key}><Icon size={18} aria-hidden="true" />{t(`landing.capabilities.${key}`)}</span>
        ))}
      </div>

      <section className="lp-section lp-benefits" aria-labelledby="landing-benefits-title">
        <div className="lp-section-heading">
          <p className="lp-eyebrow">{t('landing.features.eyebrow')}</p>
          <h2 id="landing-benefits-title">{t('landing.features.title')}</h2>
          <p>{t('landing.features.intro')}</p>
        </div>
        <div className="lp-benefit-grid">
          {BENEFITS.map(({ key, icon: Icon }, index) => (
            <article className={`lp-benefit lp-benefit-${key}`} key={key}>
              <div className="lp-benefit-top"><Icon size={23} aria-hidden="true" /><span>0{index + 1}</span></div>
              <div className="lp-benefit-visual" aria-hidden="true">
                {key === 'answer' && <><span className="lp-mini-question"><Search size={15} />{t('landing.features.answer.example')}</span><span className="lp-mini-answer"><Sparkles size={15} />{t('landing.features.answer.result')}</span></>}
                {key === 'source' && <><span className="lp-mini-timestamp"><Play size={14} fill="currentColor" />12:48</span><div className="lp-mini-timeline"><span /></div></>}
                {key === 'share' && <><div className="lp-mini-course"><Link2 size={20} /><span>{t('landing.features.share.example')}</span></div><div className="lp-mini-course"><GraduationCap size={20} /><span>{t('landing.features.share.exampleDetail')}</span></div></>}
                {key === 'insights' && <><span className="lp-mini-insight-label">{t('landing.features.insights.example')}</span><div className="lp-mini-bars">{INSIGHT_BARS.map((height, bar) => <span key={bar} style={{ height: `${height}%` }} />)}</div></>}
              </div>
              <h3>{t(`landing.features.${key}.title`)}</h3>
              <p>{t(`landing.features.${key}.body`)}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="lp-section lp-compare" aria-labelledby="landing-compare-title">
        <div className="lp-section-heading">
          <p className="lp-eyebrow">{t('landing.compare.eyebrow')}</p>
          <h2 id="landing-compare-title">{t('landing.compare.title')}</h2>
        </div>
        <table className="lp-compare-table">
          <caption className="sr-only">{t('landing.compare.caption')}</caption>
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">{t('landing.compare.rowLabel')}</span></th>
              <th scope="col">{t('landing.compare.generic')}</th>
              <th scope="col" className="lp-compare-videoq">{t('landing.compare.videoq')}</th>
            </tr>
          </thead>
          <tbody>
            {COMPARE_ROWS.map(row => (
              <tr key={row}>
                <th scope="row">{t(`landing.compare.rows.${row}.label`)}</th>
                <td>{t(`landing.compare.rows.${row}.generic`)}</td>
                <td className="lp-compare-videoq"><Check size={16} aria-hidden="true" />{t(`landing.compare.rows.${row}.videoq`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="lp-section lp-uses" aria-labelledby="landing-uses-title">
        <div className="lp-uses-copy">
          <p className="lp-eyebrow">{t('landing.uses.eyebrow')}</p>
          <h2 id="landing-uses-title">{t('landing.uses.title')}</h2>
          <p>{t('landing.uses.intro')}</p>
          <div className="lp-use-options" role="group" aria-label={t('landing.uses.select')}>
            {USES.map(({ key, icon: Icon }) => (
              <button key={key} type="button" aria-pressed={activeUse === key} aria-controls="landing-use-detail" onClick={() => setActiveUse(key)}>
                <Icon size={20} aria-hidden="true" /><span>{t(`landing.uses.${key}.label`)}</span><ArrowRight size={17} aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
        <div className="lp-use-detail" id="landing-use-detail" aria-live="polite" aria-atomic="true">
          <span className="lp-use-tag">{t(`landing.uses.${activeUse}.tag`)}</span>
          <h3>{t(`landing.uses.${activeUse}.title`)}</h3>
          <p>{t(`landing.uses.${activeUse}.body`)}</p>
          <div className="lp-use-example">
            <div className="lp-use-file"><Play size={20} aria-hidden="true" /><span>{t(`landing.uses.${activeUse}.video`)}</span><span>MP4</span></div>
            <ArrowDown size={18} aria-hidden="true" />
            <p><MessageCircle size={18} aria-hidden="true" />{t(`landing.uses.${activeUse}.question`)}</p>
          </div>
          <span className="lp-use-caption">{t('landing.uses.exampleNote')}</span>
        </div>
      </section>

      <section className="lp-section lp-steps" aria-labelledby="landing-steps-title">
        <div className="lp-section-heading">
          <p className="lp-eyebrow">{t('landing.steps.eyebrow')}</p>
          <h2 id="landing-steps-title">{t('landing.steps.title')}</h2>
          <p>{t('landing.steps.intro')}</p>
        </div>
        <ol className="lp-step-grid">
          {STEPS.map(({ key, icon: Icon }, index) => (
            <li key={key}>
              <div className="lp-step-top"><span>0{index + 1}</span><Icon size={24} aria-hidden="true" />{index < 2 && <ArrowRight className="lp-step-arrow" size={22} aria-hidden="true" />}</div>
              <h3>{t(`landing.steps.${key}.title`)}</h3>
              <p>{t(`landing.steps.${key}.body`)}</p>
            </li>
          ))}
        </ol>
        <p className="lp-step-note">{t('landing.steps.note')}</p>
      </section>

      <LandingFreePlan />

      <section className="lp-section lp-faq" aria-labelledby="landing-faq-title">
        <div>
          <p className="lp-eyebrow">{t('landing.faq.eyebrow')}</p>
          <h2 id="landing-faq-title">{t('landing.faq.title')}</h2>
          <Link href="/pricing" className="lp-text-link">{t('landing.faq.pricing')}<ArrowRight size={16} aria-hidden="true" /></Link>
          <Link href="/guides" className="lp-text-link">{t('landing.faq.guides')}<ArrowRight size={16} aria-hidden="true" /></Link>
        </div>
        <div className="lp-faq-items">
          {FAQ_KEYS.map(key => (
            <details key={key}>
              <summary>{t(`landing.faq.${key}.question`)}<ChevronDown size={19} aria-hidden="true" /></summary>
              <p>{t(`landing.faq.${key}.answer`)}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="lp-final" aria-labelledby="landing-next-title">
        <div className="lp-final-decoration" aria-hidden="true">Q</div>
        <div className="lp-final-content">
          <p className="lp-eyebrow">{t('landing.next.eyebrow')}</p>
          <h2 id="landing-next-title">{t('landing.next.title')}</h2>
          <p>{t('landing.next.intro')}</p>
          <Link href="/signup" className="lp-button lp-button-lime" onClick={() => trackLandingEvent('signup_click', 'footer')}>{t('landing.tryOwn')}<ArrowRight size={18} aria-hidden="true" /></Link>
          <p className="lp-final-note"><Check size={15} aria-hidden="true" />{t('landing.startNote')}</p>
          <Link href="/login" className="lp-final-login">{t('landing.login')}</Link>
        </div>
      </section>

      <div className="lp-mobile-cta">
        <Link href="/try" onClick={() => trackLandingEvent('demo_open', 'mobile')}>{t('landing.tryDemo')}<ArrowRight size={16} aria-hidden="true" /></Link>
        <Link href="/signup" className="lp-button lp-button-primary" onClick={() => trackLandingEvent('signup_click', 'mobile')}>{t('landing.start')}<ArrowRight size={17} aria-hidden="true" /></Link>
      </div>
    </div>
  );
}
