import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * tailwind-merge only dedupes utilities it can classify. The Digital Agency
 * Design System adds custom scales that tailwind-merge's default config does not
 * recognize, which breaks `cn()` in two ways:
 *
 *  1. Collision — DA defines both `--color-*` and `--text-*` in the Tailwind v4
 *     `@theme` block, so `text-key-900` (color) and `text-oln-16B-100`
 *     (font-size) both look like `text-*`. The default config treats them as one
 *     group and strips one when they coexist.
 *  2. Missed dedupe — numeric DA scales (`rounded-8`, `shadow-1`, `leading-150`)
 *     are not in the default validators, so overrides like
 *     `cn("rounded-full", "rounded-8")` keep BOTH and the intended override may
 *     not win.
 *
 * We patch the config so `cn()` classifies every DA scale correctly. A validator
 * only receives the value after the utility prefix (e.g. "8" for `rounded-8`), so
 * each is scoped to its own group.
 */
const isDaFontSize = (value: string) =>
  /^(dsp|std|dns|oln|mono)-\S+$/.test(value)
const isDaRadius = (value: string) => /^(4|6|8|12|16|24|32)$/.test(value)
const isDaShadow = (value: string) => /^[1-8]$/.test(value)
const isDaLineHeight = (value: string) => /^(\d{2,3}|1-\d{1,2})$/.test(value)

type Validator = (value: string) => boolean

const twMerge = extendTailwindMerge((config) => {
  // Types are derived from the config to avoid `any`.
  type ClassGroup = (typeof config.classGroups)["text-color"]
  type ClassDef = ClassGroup[number]

  // Append a validator to an existing class group keyed by its utility prefix.
  const register = (group: ClassGroup, key: string, match: Validator) => {
    const entry = group[0] as Record<string, ClassDef[]>
    entry[key]?.push(match)
  }

  // (1) Stop the text-color group from swallowing DA font-size tokens…
  const textColor = config.classGroups["text-color"][0] as { text: ClassDef[] }
  config.classGroups["text-color"] = [
    {
      text: textColor.text.map((v) =>
        typeof v === "function"
          ? (((value: string) =>
              isDaFontSize(value)
                ? false
                : (v as Validator)(value)))
          : v
      ),
    },
  ]
  // …and register them as font sizes instead.
  register(config.classGroups["font-size"], "text", isDaFontSize)

  // (2) Register the numeric DA scales so overrides dedupe correctly.
  register(config.classGroups["rounded"], "rounded", isDaRadius)
  register(config.classGroups["shadow"], "shadow", isDaShadow)
  register(config.classGroups["leading"], "leading", isDaLineHeight)

  return config
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
