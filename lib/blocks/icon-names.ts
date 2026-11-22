/**
 * The curated icon set a block `select` field may carry.
 *
 * Four layers need this list: the renderer's `<BlockIcon>` map, the scaffolder
 * (to recognize an icon-valued `select` and route it through `<BlockIcon>`), and
 * the two authoring prompts that advertise the set to the model. It lives here —
 * a dependency-free module importable from Node authoring code and from React —
 * so `render-helpers.tsx` can be checked against it by the compiler
 * (`satisfies Record<BlockIconName, LucideIcon>`) and the prompts can
 * interpolate it instead of restating it.
 *
 * Adding an icon: append here, then add the matching lucide import to the
 * `BLOCK_ICONS` map — `tsc` fails until you do.
 */
export const BLOCK_ICON_NAMES = [
  "CloudUpload",
  "Lock",
  "Server",
  "Database",
  "Shield",
  "Zap",
  "Rocket",
  "Globe",
  "Gauge",
  "RefreshCw",
  "GitBranch",
  "Settings",
] as const

export type BlockIconName = (typeof BLOCK_ICON_NAMES)[number]
