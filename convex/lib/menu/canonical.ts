import {
  isColumnPanel,
  mapPanelSections,
  panelSections,
  type PanelSection,
  type L10n,
  type LocaleNavItem,
  type LocalePanelSection,
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

function localizeSection(
  section: PanelSection,
  locale: string
): LocalePanelSection | null {
  if (section.kind === "linkGroup") {
    return {
      ...section,
      heading: localeText(section.heading, locale),
      links: section.links.flatMap((link) => {
        const label = localeText(link.label, locale)
        if (label === undefined) return []
        return [
          { ...link, label, description: localeText(link.description, locale) },
        ]
      }),
    }
  }
  if (section.kind === "dynamicList") {
    const seeAllLabel =
      section.seeAll && localeText(section.seeAll.label, locale)
    return {
      ...section,
      heading: localeText(section.heading, locale),
      seeAll:
        section.seeAll && seeAllLabel !== undefined
          ? { ...section.seeAll, label: seeAllLabel }
          : undefined,
    }
  }
  const heading = localeText(section.heading, locale)
  const alt = section.image && localeText(section.image.alt, locale, true)
  const linkLabel = section.link && localeText(section.link.label, locale)
  if (
    heading === undefined ||
    (section.image && alt === undefined) ||
    (section.link && linkLabel === undefined)
  )
    return null
  return {
    ...section,
    heading,
    image: section.image ? { ...section.image, alt: alt! } : undefined,
    link: section.link ? { ...section.link, label: linkLabel! } : undefined,
    description: localeText(section.description, locale),
  }
}

function localizeSections(sections: readonly PanelSection[], locale: string) {
  return sections.flatMap((section) => localizeSection(section, locale) ?? [])
}

/**
 * The canonical menu as `locale` alone authored it (M05 C6). A node whose
 * required text is missing — an item or link label, a featured section's
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
  const mapped = mapPanelSections(panel, (values) =>
    localizeSections(values, locale)
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
  /** One missing node: featured fields and seeAll group under their section. */
  countPath: string
  kind: MenuTextClass
  bag: L10n | undefined
  /** The old F09 readiness rule checks optional headings, not descriptions. */
  strictLocale: boolean
  set: (bag: L10n | undefined) => void
}

/** Menu-scoped identity: encode the node ID once, never its layout location. */
export function menuTextKey(
  owner: "item" | "panel" | "section" | "link",
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
  function sections(section: PanelSection) {
    if (section.kind === "linkGroup" || section.kind === "dynamicList") {
      add(
        "section",
        section.id,
        "heading",
        "optional",
        section.heading,
        (bag) => {
          if (bag === undefined) delete section.heading
          else section.heading = bag
        },
        true
      )
    }
    if (section.kind === "linkGroup") {
      for (const link of section.links) {
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
    } else if (section.kind === "dynamicList") {
      if (section.seeAll) {
        const seeAll = section.seeAll
        add(
          "section",
          section.id,
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
      add(
        "section",
        section.id,
        "heading",
        "required",
        section.heading,
        (bag) => {
          section.heading = bag ?? {}
        }
      )
      add(
        "section",
        section.id,
        "description",
        "optional",
        section.description,
        (bag) => {
          if (bag === undefined) delete section.description
          else section.description = bag
        }
      )
      const image = section.image
      if (image)
        add("section", section.id, "image/alt", "alt", image.alt, (bag) => {
          image.alt = bag ?? {}
        })
      const link = section.link
      if (link)
        add(
          "section",
          section.id,
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
    for (const { section } of panelSections(panel)) sections(section)
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
