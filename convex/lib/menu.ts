import { v, Infer } from "convex/values"
import type { GenericValidator } from "convex/values"
import type { Id } from "../_generated/dataModel"
import type { PublicRelationCard } from "./contentTypes/publicProjection"
import { imageField } from "./slices/fields"

export const DEFAULT_MENU_SLUGS = ["primary", "footer", "mobile"] as const

export const MENU_ICON_NAMES = [
  "FileText",
  "Users",
  "Building",
  "Briefcase",
  "Phone",
  "Mail",
  "Calendar",
  "Clock",
  "MapPin",
  "Star",
  "Heart",
  "Award",
  "BookOpen",
  "Video",
  "Image",
  "Camera",
  "Mic",
  "Music",
  "Settings",
  "HelpCircle",
  "Info",
  "AlertCircle",
  "CheckCircle",
  "ArrowRight",
  "ExternalLink",
  "Download",
  "Upload",
  "Share",
  "Home",
  "User",
  "Search",
  "Menu",
  "X",
  "Plus",
  "Minus",
  "ChevronRight",
  "ChevronDown",
  "ChevronUp",
  "ChevronLeft",
  "Scissors",
  "Sparkles",
  "Zap",
  "Shield",
  "Lock",
  "Unlock",
] as const

export type MenuIconName = (typeof MENU_ICON_NAMES)[number]

// ---- canonical static panel model (Plan 035 C3) ---------------------------

export const l10nValidator = v.record(v.string(), v.string())
export type L10n = Infer<typeof l10nValidator>

export const targetValidator = v.union(
  v.object({ type: v.literal("internal"), pageId: v.id("pages") }),
  v.object({
    type: v.literal("external"),
    url: v.string(),
    openInNewTab: v.optional(v.boolean()),
  }),
  v.object({ type: v.literal("anchor"), anchor: v.string() }),
  v.object({ type: v.literal("placeholder") })
)
export type Target = Infer<typeof targetValidator>

// `imageField` already owns scalar `alt`; canonical menus replace only that
// leaf with a locale bag while deriving every other image field from the
// shared primitive.
export const menuImageValidator = imageField
  .omit("alt")
  .extend({ alt: l10nValidator })
export type MenuImage = Infer<typeof menuImageValidator>

const blockSpanValidator = v.union(
  v.literal(1),
  v.literal(2),
  v.literal(3),
  v.literal(4)
)

/**
 * One validator factory owns the canonical authoring and future resolved
 * trees. Separate generic parameters keep label, target, and image inference
 * concrete instead of collapsing the leaves to a common supertype.
 */
export function buildNavTree<
  L extends GenericValidator,
  T extends GenericValidator,
  I extends GenericValidator,
>(label: L, target: T, image: I) {
  const link = v.object({
    id: v.string(),
    label,
    description: v.optional(label),
    icon: v.optional(v.string()),
    target,
    isDisabled: v.optional(v.boolean()),
  })
  const block = v.union(
    v.object({
      id: v.string(),
      kind: v.literal("linkGroup"),
      span: v.optional(blockSpanValidator),
      heading: v.optional(label),
      links: v.array(link),
    }),
    v.object({
      id: v.string(),
      kind: v.literal("featured"),
      span: v.optional(blockSpanValidator),
      image: v.optional(image),
      heading: label,
      description: v.optional(label),
      target: v.optional(target),
      link: v.optional(v.object({ label, target })),
    }),
    v.object({
      id: v.string(),
      kind: v.literal("dynamicList"),
      span: v.optional(blockSpanValidator),
      heading: v.optional(label),
      source: v.object({
        pageType: v.string(),
        limit: v.number(),
      }),
      seeAll: v.optional(
        v.object({
          label,
          target,
        })
      ),
    })
  )
  const blockRegion = v.object({ blocks: v.array(block) })

  return v.object({
    id: v.string(),
    label,
    target: v.optional(target),
    panel: v.optional(
      v.union(
        v.object({
          columns: blockSpanValidator,
          blocks: v.array(block),
          footer: v.optional(blockRegion),
        }),
        v.object({
          layout: v.literal("columns"),
          columns: v.array(
            v.object({
              id: v.string(),
              blocks: v.array(block),
            })
          ),
          footer: v.optional(blockRegion),
          title: v.optional(label),
          description: v.optional(label),
        })
      )
    ),
    isDisabled: v.optional(v.boolean()),
  })
}

export const navItemValidator = buildNavTree(
  l10nValidator,
  targetValidator,
  menuImageValidator
)
export type NavItem = Infer<typeof navItemValidator>
export type Panel = NonNullable<NavItem["panel"]>
export type LegacyPanel = Extract<Panel, { columns: number }>
export type ColumnPanel = Extract<Panel, { layout: "columns" }>
export type Block = LegacyPanel["blocks"][number]
export type NavLink = Extract<Block, { kind: "linkGroup" }>["links"][number]
export type DynamicListSource = Extract<
  Block,
  { kind: "dynamicList" }
>["source"]

export const localeMenuImageValidator = imageField
  .omit("alt")
  .extend({ alt: v.string() })
export const localeNavItemValidator = buildNavTree(
  v.string(),
  targetValidator,
  localeMenuImageValidator
)
export type LocaleNavItem = Infer<typeof localeNavItemValidator>
export type LocaleBlock = Extract<
  NonNullable<LocaleNavItem["panel"]>,
  { columns: number }
>["blocks"][number]

export const canonicalResolvedTargetValidator = v.union(
  v.object({
    type: v.literal("internal"),
    url: v.optional(v.string()),
  }),
  v.object({
    type: v.literal("external"),
    url: v.string(),
    openInNewTab: v.optional(v.boolean()),
  }),
  v.object({ type: v.literal("anchor"), url: v.string() }),
  v.object({ type: v.literal("placeholder"), url: v.literal("#") })
)
export const canonicalResolvedImageValidator = v.object({
  url: v.optional(v.string()),
  alt: v.string(),
})
export const canonicalResolvedNavItemValidator = buildNavTree(
  v.string(),
  canonicalResolvedTargetValidator,
  canonicalResolvedImageValidator
)
export type CanonicalResolvedNavItem = Infer<
  typeof canonicalResolvedNavItemValidator
>

export type ResolvedBlock = Extract<
  NonNullable<CanonicalResolvedNavItem["panel"]>,
  { columns: number }
>["blocks"][number]

export type MenuCardsBySource = Record<string, PublicRelationCard[]>

export function dynamicListSourceKey(source: DynamicListSource): string {
  return `${source.pageType}:${source.limit}`
}

export function collectDynamicListSources(
  ...navTrees: ReadonlyArray<readonly (NavItem | CanonicalResolvedNavItem)[]>
): DynamicListSource[] {
  const sources = new Map<string, DynamicListSource>()
  for (const nav of navTrees) {
    for (const item of nav) {
      for (const { block } of panelBlocks<Block | ResolvedBlock>(item.panel)) {
        if (block.kind === "dynamicList")
          sources.set(dynamicListSourceKey(block.source), block.source)
      }
    }
  }
  return [...sources.values()]
}

export type MenuReferenceTarget = {
  targetId: Id<"pages">
  path: string
}

function menuNodeSegment(id: string): string {
  return `id:${encodeURIComponent(id)}`
}

export function walkCanonicalMenuTargets(
  nav: readonly NavItem[]
): MenuReferenceTarget[] {
  const targets: MenuReferenceTarget[] = []
  const visitBlock = (block: Block, blockPath: string) => {
    if (block.kind === "featured") {
      const target = block.link?.target ?? block.target
      if (target?.type === "internal")
        targets.push({
          targetId: target.pageId,
          path: `${blockPath}/${block.link ? "link/target" : "target"}`,
        })
    } else if (block.kind === "dynamicList") {
      if (block.seeAll?.target.type === "internal")
        targets.push({
          targetId: block.seeAll.target.pageId,
          path: `${blockPath}/seeAll/target`,
        })
    } else {
      for (const link of block.links) {
        if (link.target.type === "internal")
          targets.push({
            targetId: link.target.pageId,
            path: `${blockPath}/links/${menuNodeSegment(link.id)}/target`,
          })
      }
    }
  }

  for (const item of nav) {
    const itemPath = `nav/${menuNodeSegment(item.id)}`
    if (item.target?.type === "internal") {
      targets.push({
        targetId: item.target.pageId,
        path: `${itemPath}/target`,
      })
    }
    if (!item.panel) continue
    for (const { block, path } of panelBlocks(item.panel)) {
      visitBlock(block, `${itemPath}/panel/${path}`)
    }
  }
  return targets
}

export function generateMenuId(): string {
  return `menu_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

/** The two persisted layouts share one traversal and mapping boundary. */
export type PanelTree<B, L = unknown> =
  | { columns: 1 | 2 | 3 | 4; blocks: B[]; footer?: { blocks: B[] } }
  | {
      layout: "columns"
      columns: { id: string; blocks: B[] }[]
      footer?: { blocks: B[] }
      title?: L
      description?: L
    }

export function isColumnPanel<P extends { columns: unknown }>(
  panel: P
): panel is Extract<P, { layout: "columns" }> {
  return "layout" in panel && panel.layout === "columns"
}

/** Panel-relative location for references; never a translation identity. */
export function panelBlocks<B extends { id: string }>(
  panel: PanelTree<B> | undefined
) {
  const entries: { block: B; path: string }[] = []
  if (!panel) return entries
  const add = (blocks: B[], path: string) => {
    for (const block of blocks)
      entries.push({
        block,
        path: `${path}/${menuNodeSegment(block.id)}`,
      })
  }
  if (isColumnPanel(panel)) {
    for (const col of panel.columns)
      add(
        col.blocks,
        `columns/${menuNodeSegment(col.id)}/blocks`
      )
  } else add(panel.blocks, "blocks")
  add(panel.footer?.blocks ?? [], "footer/blocks")
  return entries
}

/** Transform block values without changing their region, order or column metadata. */
export function mapPanelBlocks<B, R, L>(
  panel: PanelTree<B, L>,
  map: (blocks: B[]) => R[]
): PanelTree<R, L> {
  const footer = panel.footer ? { blocks: map(panel.footer.blocks) } : undefined
  return isColumnPanel(panel)
    ? {
        ...panel,
        columns: panel.columns.map((col) => ({
          ...col,
          blocks: map(col.blocks),
        })),
        footer,
      }
    : { ...panel, blocks: map(panel.blocks), footer }
}

/** Explicit editor conversion only: legacy rows keep their start-column ownership. */
export function legacyToColumns(panel: LegacyPanel): ColumnPanel {
  const copy = structuredClone(panel)
  const convertBlock = (block: Block): Block => {
    delete block.span
    if (block.kind === "featured" && block.target) {
      block.link = { label: { ...block.heading }, target: block.target }
      delete block.target
    }
    return block
  }
  const completeRow =
    panel.blocks.reduce((sum, block) => sum + (block.span ?? 1), 0) ===
    panel.columns
  const columns: ColumnPanel["columns"] = completeRow
    ? copy.blocks.map((block, index) => ({
        id: `column-${index + 1}`,
        blocks: [convertBlock(block)],
      }))
    : Array.from({ length: panel.columns }, (_, index) => ({
        id: `column-${index + 1}`,
        blocks: [],
      }))
  if (!completeRow) {
    let start = 0
    for (const block of copy.blocks) {
      const span = block.span ?? 1
      if (start + span > panel.columns) start = 0
      columns[start]!.blocks.push(convertBlock(block))
      start += span
      if (start >= panel.columns) start = 0
    }
  }
  return {
    layout: "columns",
    columns,
    ...(copy.footer
      ? { footer: { blocks: copy.footer.blocks.map(convertBlock) } }
      : {}),
  }
}

/** Compare both save paths against the same stored conversion, without mutation. */
export function menuConversionBaseline(
  existing: readonly NavItem[],
  next: readonly { id: string; panel?: PanelTree<{ id: string }> }[]
): NavItem[] {
  const nextItems = new Map(next.map((item) => [item.id, item]))
  const nextColumnBlocks = new Set(
    next.flatMap((item) =>
      item.panel && isColumnPanel(item.panel)
        ? panelBlocks(item.panel).map(({ block }) => block.id)
        : []
    )
  )
  return existing.map((item) => {
    if (!item.panel || isColumnPanel(item.panel)) return item
    const originalBlocks = new Map(
      panelBlocks(item.panel).map(({ block }) => [block.id, block])
    )
    const converted = legacyToColumns(item.panel)
    const convertedBlocks = new Map(
      panelBlocks(converted).map(({ block }) => [block.id, block])
    )
    // Item identity owns panel layout; only destination block identity seeds text.
    const nextPanel = nextItems.get(item.id)?.panel
    return {
      ...item,
      panel: mapPanelBlocks(
        nextPanel && isColumnPanel(nextPanel) ? converted : item.panel,
        (blocks) =>
          blocks.map((block) =>
            nextColumnBlocks.has(block.id)
              ? convertedBlocks.get(block.id)!
              : originalBlocks.get(block.id)!
          )
      ),
    }
  })
}
