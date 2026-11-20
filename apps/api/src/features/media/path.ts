export function mediaPathFromUrl(pathname: string): string {
  const prefix = "/api/media/";
  // createApp 経由は `/api/media/...`、feature 単体テストはマウント後の相対 path。
  const raw = pathname.startsWith(prefix)
    ? pathname.slice(prefix.length)
    : pathname.replace(/^\/+/, "");
  try {
    return decodeURIComponent(raw).replace(/^\/+/, "");
  } catch {
    // A malformed percent escape is an invalid media path, not a server error.
    return "";
  }
}
