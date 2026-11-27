const VALID_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

export const INVALID_YOUTUBE_URL_MESSAGE = "Invalid YouTube URL.";

export type YoutubeUrlParts = { protocol: string; host: string; pathname: string; videoQuery: string | null };
export function youtubeVideoIdFromParts(parsed: YoutubeUrlParts): string | null {
  const scheme = parsed.protocol.replace(/:$/, "");
  const host = parsed.host.toLowerCase(); // hostname[:port]
  if ((scheme !== "http" && scheme !== "https") || !VALID_HOSTS.has(host)) {
    return null;
  }

  const path = parsed.pathname;
  let candidate = "";
  if (host.endsWith("youtu.be")) {
    candidate = path.replace(/^\/+|\/+$/g, "").split("/")[0] ?? "";
  } else if (path === "/watch") {
    candidate = parsed.videoQuery ?? "";
  } else if (path.startsWith("/embed/") || path.startsWith("/shorts/")) {
    candidate = path.replace(/^\/+|\/+$/g, "").split("/")[1] ?? "";
  }

  const stripped = candidate.replace(/[-_]/g, "");
  if (candidate.length !== 11 || stripped.length === 0 || !/^[a-zA-Z0-9]+$/.test(stripped)) {
    return null;
  }
  return candidate;
}
