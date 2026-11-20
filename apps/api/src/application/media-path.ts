/** path traversal を拒否する。 */
export function isSafeMediaPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const parts = path.split("/");
  return !parts.some((p) => p === ".." || p === "");
}
