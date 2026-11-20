import { youtubeVideoIdFromParts } from "../application/youtube";
export { INVALID_YOUTUBE_URL_MESSAGE } from "../application/youtube";

export function extractYoutubeVideoId(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    return youtubeVideoIdFromParts({ protocol: parsed.protocol, host: parsed.host, pathname: parsed.pathname, videoQuery: parsed.searchParams.get("v") });
  } catch { return null; }
}
