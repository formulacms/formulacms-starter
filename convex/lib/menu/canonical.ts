import {
  isColumnPanel,
  mapPanelBlocks,
  panelBlocks,
  type Block,
  type L10n,
  type LocaleNavItem,
  type LocaleBlock,
  type NavItem,
} from "../menu"

/**
 * Whether `bag` holds text authored for `locale` itself. Required menu text
 * counts only as non-blank own text; image alt (`allowEmpty`) counts by key,
 * because an empty alt marks a decorative image. Another language's text
 * never counts. The public resolver and the default-migration menu blocker
 * share this one rule.
 */
export function hasLocaleText(
  bag: L10n,
  locale: string,
  allowEmpty = false
): boolean {
  if (!Object.prototype.hasOwnProperty.call(bag, locale)) return false
  if (allowEmpty) return true
  const value = (bag as Record<string, string | undefined>)[locale]
  return value !== undefined && value.trim().length > 0
}

/**
 * The text `locale` authored in `bag`, or `undefined`. M05 C6 (owner decision,
 * 2026-09-15): menu text never falls back to the default language, so a
 * caller omits a node whose required text is `undefined` and drops an
 * optional field whose text is `undefined`.
 */
export function localeText(
  bag: L10n | undefined,
  locale: string,
  allowEmpty = false
): string | undefined {
  return bag !== undefined && hasLocaleText(bag, locale, allowEmpty)
    ? bag[locale]
    : undefined
}

function localizeBlock(block: Block, locale: string): LocaleBlock | null {
  if (block.kind === "linkGroup") {
    return {
      ...block,
      heading: localeText(block.heading, locale),
      links: block.links.flatMap((link) => {
        const label = localeText(link.label, locale)
        if (label === undefined) return []
        return [
          { ...link, label, description: localeText(link.description, locale) },
        ]
      }),
    }
  }
  if (block.kind === "dynamicList") {
    const seeAllLabel = block.seeAll && localeText(block.seeAll.label, locale)
    return {
      ...block,
      heading: localeText(block.heading, locale),
      seeAll:
        block.seeAll && seeAllLabel !== undefined
          ? { ...block.seeAll, label: seeAllLabel }
          : undefined,
    }
  }
  const heading = localeText(block.heading, locale)
  const alt = block.image && localeText(block.image.alt, locale, true)
  const linkLabel = block.link && localeText(block.link.label, locale)
  if (
    heading === undefined ||
    (block.image && alt === undefined) ||
    (block.link && linkLabel === undefined)
  )
    return null
  return {
    ...block,
    heading,
    image: block.image ? { ...block.image, alt: alt! } : undefined,
    link: block.link ? { ...block.link, label: linkLabel! } : undefined,
    description: localeText(block.description, locale),
  }
}

function localizeBlocks(blocks: readonly Block[], locale: string) {
  return blocks.flatMap((block) => localizeBlock(block, locale) ?? [])
}

/**
 * The canonical menu as `locale` alone authored it (M05 C6). A node whose
 * required text is missing — an item or link label, a featured block's
 * heading or image alt, a see-all label — is omitted with its subtree;
 * optional text (descriptions, group and list headings) drops field by
 * field. Targets are untouched: hrefs keep their same-locale rule where they
 * are resolved.
 */
export function localizeCanonicalNav(
  nav: readonly NavItem[],
  locale: string
): LocaleNavItem[] {
  return nav.flatMap((item) => {
    const label = localeText(item.label, locale)
    if (label === undefined) return []
    return [
      {
        ...item,
        label,
        panel: item.panel ? localizePanel(item.panel, locale) : undefined,
      },
    ]
  })
}

function localizePanel(
  panel: NonNullable<NavItem["panel"]>,
  locale: string
): NonNullable<LocaleNavItem["panel"]> {
  const mapped = mapPanelBlocks(panel, (values) =>
    localizeBlocks(values, locale)
  )
  return isColumnPanel(mapped)
    ? {
        ...mapped,
        title: localeText(mapped.title, locale),
        description: localeText(mapped.description, locale),
      }
    : mapped
}

/** Status counts lost nodes once; untranslated optional headings lose no node. */
export function countMenuNodesMissingText(
  nav: readonly NavItem[],
  locale: string
): number {
  return new Set(
    menuTextLeaves(nav)
      .filter(
        (leaf) =>
          leaf.kind !== "optional" &&
          !hasLocaleText(leaf.bag ?? {}, locale, leaf.kind === "alt")
      )
      .map((leaf) => leaf.countPath)
  ).size
}

export type MenuTextClass = "required" | "optional" | "alt"
export type MenuTextLeaf = {
  /** Stable leaf identity within this menu. */
  path: string
  /** Surviving owner, including removable link/seeAll roles. */
  nodePath: string
  /** One missing node: featured fields and seeAll group under their block. */
  countPath: string
  kind: MenuTextClass
  bag: L10n | undefined
  /** The old F09 readiness rule checks optional headings, not descriptions. */
  strictLocale: boolean
  set: (bag: L10n | undefined) => void
}

/** Menu-scoped identity: encode the node ID once, never its layout location. */
export function menuTextKey(
  owner: "item" | "panel" | "block" | "link",
  id: string,
  field?: string
): string {
  return `${owner}/${encodeURIComponent(id)}${field ? `/${field}` : ""}`
}

/** One inventory for menu text; destinations never participate in it. */
export function menuTextLeaves(nav: readonly NavItem[]): MenuTextLeaf[] {
  const leaves: MenuTextLeaf[] = []
  function add(
    owner: Parameters<typeof menuTextKey>[0],
    id: string,
    field: string,
    kind: MenuTextClass,
    bag: L10n | undefined,
    set: MenuTextLeaf["set"],
    strictLocale = kind !== "optional",
    subowner?: "link" | "seeAll"
  ) {
    leaves.push({
      path: menuTextKey(owner, id, field),
      nodePath: menuTextKey(owner, id, subowner),
      countPath: menuTextKey(owner, id),
      kind,
      bag,
      set,
      strictLocale,
    })
  }
  function blocks(block: Block) {
    if (block.kind === "linkGroup" || block.kind === "dynamicList") {
      add(
        "block",
        block.id,
        "heading",
        "optional",
        block.heading,
        (bag) => {
          if (bag === undefined) delete block.heading
          else block.heading = bag
        },
        true
      )
    }
    if (block.kind === "linkGroup") {
      for (const link of block.links) {
        add("link", link.id, "label", "required", link.label, (bag) => {
          link.label = bag ?? {}
        })
        add(
          "link",
          link.id,
          "description",
          "optional",
          link.description,
          (bag) => {
            if (bag === undefined) delete link.description
            else link.description = bag
          }
        )
      }
    } else if (block.kind === "dynamicList") {
      if (block.seeAll) {
        const seeAll = block.seeAll
        add(
          "block",
          block.id,
          "seeAll/label",
          "required",
          seeAll.label,
          (bag) => {
            seeAll.label = bag ?? {}
          },
          true,
          "seeAll"
        )
      }
    } else {
      add("block", block.id, "heading", "required", block.heading, (bag) => {
        block.heading = bag ?? {}
      })
      add(
        "block",
        block.id,
        "description",
        "optional",
        block.description,
        (bag) => {
          if (bag === undefined) delete block.description
          else block.description = bag
        }
      )
      const image = block.image
      if (image)
        add("block", block.id, "image/alt", "alt", image.alt, (bag) => {
          image.alt = bag ?? {}
        })
      const link = block.link
      if (link)
        add(
          "block",
          block.id,
          "link/label",
          "required",
          link.label,
          (bag) => {
            link.label = bag ?? {}
          },
          true,
          "link"
        )
    }
  }
  for (const item of nav) {
    add("item", item.id, "label", "required", item.label, (bag) => {
      item.label = bag ?? {}
    })
    const panel = item.panel
    if (panel && isColumnPanel(panel)) {
      for (const field of ["title", "description"] as const) {
        add("panel", item.id, field, "optional", panel[field], (bag) => {
          if (bag === undefined) delete panel[field]
          else panel[field] = bag
        })
      }
    }
    for (const { block } of panelBlocks(panel)) blocks(block)
  }
  return leaves
}

/** Blank optional text means absent; alt's authored empty string is retained. */
export function normalizeMenuTextBag(
  bag: L10n | undefined,
  kind: MenuTextClass
): L10n {
  return Object.fromEntries(
    Object.entries(bag ?? {}).filter(
      ([, text]) => kind !== "optional" || text.trim().length > 0
    )
  )
}

export function normalizeOptionalMenuText(nav: readonly NavItem[]): NavItem[] {
  // Menu validators contain only JSON data; use the existing writeShapes clone pattern.
  const normalized = JSON.parse(JSON.stringify(nav)) as NavItem[]
  for (const leaf of menuTextLeaves(normalized)) {
    if (leaf.kind !== "optional") continue
    const bag = normalizeMenuTextBag(leaf.bag, leaf.kind)
    leaf.set(Object.keys(bag).length > 0 ? bag : undefined)
  }
  return normalized
}
