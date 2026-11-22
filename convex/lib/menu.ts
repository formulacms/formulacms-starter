import { v, Infer } from "convex/values"
import type { GenericValidator } from "convex/values"
import type { Id } from "../_generated/dataModel"
import type { PublicRelationCard } from "./contentTypes/publicProjection"
import { imageField } from "./blocks/fields"

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

const sectionSpanValidator = v.union(
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
  const section = v.union(
    v.object({
      id: v.string(),
      kind: v.literal("linkGroup"),
      span: v.optional(sectionSpanValidator),
      heading: v.optional(label),
      links: v.array(link),
    }),
    v.object({
      id: v.string(),
      kind: v.literal("featured"),
      span: v.optional(sectionSpanValidator),
      image: v.optional(image),
      heading: label,
      description: v.optional(label),
      target: v.optional(target),
      link: v.optional(v.object({ label, target })),
    }),
    v.object({
      id: v.string(),
      kind: v.literal("dynamicList"),
      span: v.optional(sectionSpanValidator),
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
  const sectionRegion = v.object({ sections: v.array(section) })

  return v.object({
    id: v.string(),
    label,
    target: v.optional(target),
    panel: v.optional(
      v.union(
        v.object({
          columns: sectionSpanValidator,
          sections: v.array(section),
          footer: v.optional(sectionRegion),
        }),
        v.object({
          layout: v.literal("columns"),
          columns: v.array(
            v.object({
              id: v.string(),
              sections: v.array(section),
            })
          ),
          footer: v.optional(sectionRegion),
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
export type PanelSection = LegacyPanel["sections"][number]
export type NavLink = Extract<PanelSection, { kind: "linkGroup" }>["links"][number]
export type DynamicListSource = Extract<
  PanelSection,
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
export type LocalePanelSection = Extract<
  NonNullable<LocaleNavItem["panel"]>,
  { columns: number }
>["sections"][number]

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

export type ResolvedPanelSection = Extract<
  NonNullable<CanonicalResolvedNavItem["panel"]>,
  { columns: number }
>["sections"][number]

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
      for (const { section } of panelSections<PanelSection | ResolvedPanelSection>(item.panel)) {
        if (section.kind === "dynamicList")
          sources.set(dynamicListSourceKey(section.source), section.source)
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
  const visitSection = (section: PanelSection, sectionPath: string) => {
    if (section.kind === "featured") {
      const target = section.link?.target ?? section.target
      if (target?.type === "internal")
        targets.push({
          targetId: target.pageId,
          path: `${sectionPath}/${section.link ? "link/target" : "target"}`,
        })
    } else if (section.kind === "dynamicList") {
      if (section.seeAll?.target.type === "internal")
        targets.push({
          targetId: section.seeAll.target.pageId,
          path: `${sectionPath}/seeAll/target`,
        })
    } else {
      for (const link of section.links) {
        if (link.target.type === "internal")
          targets.push({
            targetId: link.target.pageId,
            path: `${sectionPath}/links/${menuNodeSegment(link.id)}/target`,
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
    for (const { section, path } of panelSections(item.panel)) {
      visitSection(section, `${itemPath}/panel/${path}`)
    }
  }
  return targets
}

export function generateMenuId(): string {
  return `menu_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

/** The two persisted layouts share one traversal and mapping boundary. */
export type PanelTree<B, L = unknown> =
  | { columns: 1 | 2 | 3 | 4; sections: B[]; footer?: { sections: B[] } }
  | {
      layout: "columns"
      columns: { id: string; sections: B[] }[]
      footer?: { sections: B[] }
      title?: L
      description?: L
    }

export function isColumnPanel<P extends { columns: unknown }>(
  panel: P
): panel is Extract<P, { layout: "columns" }> {
  return "layout" in panel && panel.layout === "columns"
}

/** Panel-relative location for references; never a translation identity. */
export function panelSections<B extends { id: string }>(
  panel: PanelTree<B> | undefined
) {
  const entries: { section: B; path: string }[] = []
  if (!panel) return entries
  const add = (sections: B[], path: string) => {
    for (const section of sections)
      entries.push({
        section,
        path: `${path}/${menuNodeSegment(section.id)}`,
      })
  }
  if (isColumnPanel(panel)) {
    for (const col of panel.columns)
      add(
        col.sections,
        `columns/${menuNodeSegment(col.id)}/sections`
      )
  } else add(panel.sections, "sections")
  add(panel.footer?.sections ?? [], "footer/sections")
  return entries
}

/** Transform section values without changing their region, order or column metadata. */
export function mapPanelSections<B, R, L>(
  panel: PanelTree<B, L>,
  map: (sections: B[]) => R[]
): PanelTree<R, L> {
  const footer = panel.footer ? { sections: map(panel.footer.sections) } : undefined
  return isColumnPanel(panel)
    ? {
        ...panel,
        columns: panel.columns.map((col) => ({
          ...col,
          sections: map(col.sections),
        })),
        footer,
      }
    : { ...panel, sections: map(panel.sections), footer }
}

/** Explicit editor conversion only: legacy rows keep their start-column ownership. */
export function legacyToColumns(panel: LegacyPanel): ColumnPanel {
  const copy = structuredClone(panel)
  const convertSection = (section: PanelSection): PanelSection => {
    delete section.span
    if (section.kind === "featured" && section.target) {
      section.link = { label: { ...section.heading }, target: section.target }
      delete section.target
    }
    return section
  }
  const completeRow =
    panel.sections.reduce((sum, section) => sum + (section.span ?? 1), 0) ===
    panel.columns
  const columns: ColumnPanel["columns"] = completeRow
    ? copy.sections.map((section, index) => ({
        id: `column-${index + 1}`,
        sections: [convertSection(section)],
      }))
    : Array.from({ length: panel.columns }, (_, index) => ({
        id: `column-${index + 1}`,
        sections: [],
      }))
  if (!completeRow) {
    let start = 0
    for (const section of copy.sections) {
      const span = section.span ?? 1
      if (start + span > panel.columns) start = 0
      columns[start]!.sections.push(convertSection(section))
      start += span
      if (start >= panel.columns) start = 0
    }
  }
  return {
    layout: "columns",
    columns,
    ...(copy.footer
      ? { footer: { sections: copy.footer.sections.map(convertSection) } }
      : {}),
  }
}

/** Compare both save paths against the same stored conversion, without mutation. */
export function menuConversionBaseline(
  existing: readonly NavItem[],
  next: readonly { id: string; panel?: PanelTree<{ id: string }> }[]
): NavItem[] {
  const nextItems = new Map(next.map((item) => [item.id, item]))
  const nextColumnSections = new Set(
    next.flatMap((item) =>
      item.panel && isColumnPanel(item.panel)
        ? panelSections(item.panel).map(({ section }) => section.id)
        : []
    )
  )
  return existing.map((item) => {
    if (!item.panel || isColumnPanel(item.panel)) return item
    const originalSections = new Map(
      panelSections(item.panel).map(({ section }) => [section.id, section])
    )
    const converted = legacyToColumns(item.panel)
    const convertedSections = new Map(
      panelSections(converted).map(({ section }) => [section.id, section])
    )
    // Item identity owns panel layout; only destination section identity seeds text.
    const nextPanel = nextItems.get(item.id)?.panel
    return {
      ...item,
      panel: mapPanelSections(
        nextPanel && isColumnPanel(nextPanel) ? converted : item.panel,
        (sections) =>
          sections.map((section) =>
            nextColumnSections.has(section.id)
              ? convertedSections.get(section.id)!
              : originalSections.get(section.id)!
          )
      ),
    }
  })
}
