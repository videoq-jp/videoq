import metadata from './providerDemoMetadata.json';

export const PROVIDER_DEMO_STEPS = ['prepare', 'share', 'answer', 'review'] as const;

export function providerDemoMedia(language?: string) {
  const locale = language?.startsWith('en') ? 'en' : 'ja';
  const {version,duration,uploadDate}=metadata[locale];
  return {
    locale,
    duration,
    uploadDate,
    aspectRatio: '16 / 9',
    video: `/demo/provider-demo-${locale}.mp4?v=${version}`,
    poster: `/demo/provider-demo-${locale}-poster.webp?v=${version}`,
    captions: `/demo/provider-demo-${locale}.vtt?v=${version}`,
  };
}
