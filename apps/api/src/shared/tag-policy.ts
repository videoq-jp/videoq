import { TAG_COLORS } from "@videoq/trpc";

export const INVALID_COLOR_MESSAGE = `Invalid color. Use a ChipLabel palette name (${TAG_COLORS.join(", ")})`;
export const EMPTY_NAME_MESSAGE = "Tag name cannot be empty";

/** TagPolicy.normalize_name: strip → 空なら null（呼び出し側で 400）。 */
export function normalizeTagName(name: string): string | null {
  const s = name.trim();
  return s === "" ? null : s;
}

/** TagPolicy.validate_color: パレット名の完全一致のみ。 */
export function isValidTagColor(color: string): boolean {
  return (TAG_COLORS as readonly string[]).includes(color);
}
