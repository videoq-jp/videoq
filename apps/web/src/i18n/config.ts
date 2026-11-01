import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enTranslation from './locales/en/translation.json';
import jaTranslation from './locales/ja/translation.json';

export const defaultLocale = 'ja';
export const locales = ['ja', 'en'] as const;
export type Locale = typeof locales[number];

// Prerendered English pages must hydrate with the language they were rendered in.
const initialLocale: Locale = typeof location !== 'undefined' && /^\/en(\/|$)/.test(location.pathname) ? 'en' : defaultLocale;

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: enTranslation },
    ja: { translation: jaTranslation },
  },
  lng: initialLocale,
  fallbackLng: defaultLocale,
  interpolation: { escapeValue: false },
});

export default i18n;
