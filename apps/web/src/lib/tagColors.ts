import type { ChipLabelColor } from '@/components/ui/chip-label'
import { TAG_COLORS } from '@videoq/domain/tag-policy'

/** Digital Agency ChipLabel palette used for tags */
export const TAG_CHIP_COLORS = TAG_COLORS satisfies readonly ChipLabelColor[]

export type TagChipColor = (typeof TAG_COLORS)[number]

export const DEFAULT_TAG_CHIP_COLOR: TagChipColor = 'blue'

const TAG_CHIP_COLOR_SET = new Set<string>(TAG_CHIP_COLORS)

/** Legacy hex → palette mapping for existing tags */
const LEGACY_HEX_TO_CHIP: Record<string, TagChipColor> = {
  '#3b82f6': 'blue',
  '#10b981': 'green',
  '#f59e0b': 'yellow',
  '#ef4444': 'red',
  '#8b5cf6': 'purple',
  '#ec4899': 'magenta',
  '#6366f1': 'purple',
  '#14b8a6': 'cyan',
  '#ff0000': 'red',
  '#00ff00': 'green',
  '#0000ff': 'blue',
  '#111111': 'gray',
  '#222222': 'gray',
  '#ffffff': 'gray',
  '#ab12f0': 'purple',
}

export function isTagChipColor(value: string): value is TagChipColor {
  return TAG_CHIP_COLOR_SET.has(value)
}

/**
 * Resolve a stored tag color (palette name or legacy hex) to a ChipLabel color.
 */
export function resolveTagChipColor(color: string): TagChipColor {
  if (isTagChipColor(color)) {
    return color
  }

  const mapped = LEGACY_HEX_TO_CHIP[color.trim().toLowerCase()]
  return mapped ?? DEFAULT_TAG_CHIP_COLOR
}
