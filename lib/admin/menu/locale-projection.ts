import {
  isColumnPanel,
  mapPanelBlocks,
  menuConversionBaseline,
  panelBlocks,
  type Block,
  type L10n,
  type LocaleBlock,
  type LocaleNavItem,
  type NavItem,
  type NavLink,
} from "@/convex/lib/menu"
import { menuTextKey, menuTextLeaves } from "@/convex/lib/menu/canonical"

// Editor-only presence metadata: ordinary blank text still means omission.
// A block spread retains this symbol; canonical writes select known leaves.
const altPresence = Symbol("menuAltPresence")
type AltPresence = { [altPresence]?: boolean }

export function withAuthoredAlt(
  block: Extract<LocaleBlock, { kind: "featured" }>,
  alt: string
) {
  return { ...block, [altPresence]: true, image: { ...block.image, alt } }
}

function projectBlock(
  block: Block,
  locale: string,
  texts: Map<string, string | undefined>
): LocaleBlock & AltPresence {
  const key = (field: string) => menuTextKey("block", block.id, field)
  if (block.kind === "linkGroup") {
    return {
      ...block,
      heading: texts.get(key("heading")),
      links: block.links.map((link) => ({
        ...link,
        label: texts.get(menuTextKey("link", link.id, "label")) ?? "",
        description: texts.get(menuTextKey("link", link.id, "description")),
      })),
    }
  }
  if (block.kind === "dynamicList") {
    return {
      ...block,
      heading: texts.get(key("heading")),
      seeAll: block.seeAll
        ? { ...block.seeAll, label: texts.get(key("seeAll/label")) ?? "" }
        : undefined,
    }
  }
  return {
    ...block,
    [altPresence]: block.image ? Object.hasOwn(block.image.alt, locale) : false,
    image: block.image
      ? { ...block.image, alt: texts.get(key("image/alt")) ?? "" }
      : undefined,
    link: block.link
      ? { ...block.link, label: texts.get(key("link/label")) ?? "" }
      : undefined,
    heading: texts.get(key("heading")) ?? "",
    description: texts.get(key("description")),
  }
}

export function projectLocale(
  nav: readonly NavItem[],
  locale: string,
  _defaultLocale: string
): LocaleNavItem[] {
  // Retain the third argument for existing callers; text never falls back.
  void _defaultLocale
  const texts = new Map(
    menuTextLeaves(nav).map((leaf) => {
      const value = leaf.bag?.[locale]
      return [
        leaf.path,
        leaf.kind === "optional" && !value?.trim() ? undefined : value,
      ] as const
    })
  )
  return nav.map((item) => {
    const panel =
      item.panel &&
      mapPanelBlocks(item.panel, (values) =>
        values.map((block) => projectBlock(block, locale, texts))
      )

    return {
      ...item,
      label: texts.get(menuTextKey("item", item.id, "label")) ?? "",
      panel:
        panel && isColumnPanel(panel)
          ? {
              ...panel,
              title: texts.get(menuTextKey("panel", item.id, "title")),
              description: texts.get(
                menuTextKey("panel", item.id, "description")
              ),
            }
          : panel,
    }
  })
}

export function localesWithMenuText(nav: readonly NavItem[]): Set<string> {
  return new Set(
    menuTextLeaves(nav).flatMap((leaf) => Object.keys(leaf.bag ?? {}))
  )
}

/** Track edits from the structure editor just as the localized alt input does. */
export function retainAuthoredAlt(
  previous: readonly LocaleNavItem[],
  next: LocaleNavItem[]
): LocaleNavItem[] {
  const oldBlocks = new Map(
    previous
      .flatMap((item) => panelBlocks(item.panel).map((entry) => entry.block))
      .map((block) => [block.id, block])
  )
  const blocks = (values: LocaleBlock[]) =>
    values.map((block) => {
      const old = oldBlocks.get(block.id)
      return block.kind === "featured" &&
        old?.kind === "featured" &&
        block.image &&
        old.image?.alt !== block.image.alt
        ? withAuthoredAlt(block, block.image.alt)
        : block
    })
  return next.map((item) => ({
    ...item,
    panel: item.panel ? mapPanelBlocks(item.panel, blocks) : undefined,
  }))
}

function withLocale(value: L10n, locale: string, text: string): L10n {
  if (text.trim().length > 0) return { ...value, [locale]: text }
  const next = { ...value }
  delete next[locale]
  return next
}

function withAltLocale(
  value: L10n,
  locale: string,
  text: string,
  authored: boolean | undefined
): L10n {
  if (
    text.trim().length > 0 ||
    authored === true ||
    (authored === undefined &&
      Object.prototype.hasOwnProperty.call(value, locale))
  )
    return { ...value, [locale]: text }
  return withLocale(value, locale, "")
}

function withOptionalLocale(
  value: L10n | undefined,
  locale: string,
  text: string | undefined
): L10n | undefined {
  if (text !== undefined && text.trim().length > 0) {
    return { ...(value ?? {}), [locale]: text }
  }
  if (!value || !Object.prototype.hasOwnProperty.call(value, locale)) {
    return value
  }
  const next = { ...value }
  delete next[locale]
  return Object.keys(next).length > 0 ? next : undefined
}

function sharedShape(nav: readonly NavItem[] | readonly LocaleNavItem[]) {
  const blockShape = (block: Block | LocaleBlock) => {
    if (block.kind === "linkGroup") {
      return {
        id: block.id,
        kind: block.kind,
        span: block.span,
        links: block.links.map((link) => ({
          id: link.id,
          icon: link.icon,
          target: link.target,
          isDisabled: link.isDisabled,
        })),
      }
    }
    if (block.kind === "dynamicList") {
      return {
        id: block.id,
        kind: block.kind,
        span: block.span,
        source: block.source,
        seeAll: block.seeAll ? { target: block.seeAll.target } : undefined,
      }
    }
    return {
      id: block.id,
      kind: block.kind,
      span: block.span,
      image:
        block.image &&
        Object.fromEntries(
          Object.entries(block.image).filter(([key]) => key !== "alt")
        ),
      target: block.target,
      link: block.link ? { target: block.link.target } : undefined,
    }
  }
  return nav.map((item) => ({
    id: item.id,
    target: item.target,
    isDisabled: item.isDisabled,
    panel: item.panel
      ? (() => {
          const panel = mapPanelBlocks<
            Block | LocaleBlock,
            ReturnType<typeof blockShape>,
            unknown
          >(item.panel, (values) => values.map(blockShape))
          if (!isColumnPanel(panel)) return panel
          const { title: _title, description: _description, ...shape } = panel
          void _title
          void _description
          return shape
        })()
      : undefined,
  }))
}

function requireMatchingSharedShape(
  nav: readonly NavItem[],
  edited: readonly LocaleNavItem[]
): void {
  if (
    JSON.stringify(sharedShape(nav)) !== JSON.stringify(sharedShape(edited))
  ) {
    throw new Error(
      "Localized menu edits cannot change shared structure or targets"
    )
  }
}

function mergeBlockLocale(
  block: Block,
  edited: LocaleBlock,
  locale: string
): Block {
  if (block.kind !== edited.kind || block.id !== edited.id) {
    throw new Error("Localized menu block IDs and kinds must match")
  }
  if (block.kind === "linkGroup" && edited.kind === "linkGroup") {
    return {
      ...block,
      heading: withOptionalLocale(block.heading, locale, edited.heading),
      links: block.links.map((link, index) => {
        const editedLink = edited.links[index]
        if (!editedLink || editedLink.id !== link.id) {
          throw new Error("Localized menu link IDs and order must match")
        }
        return {
          ...link,
          label: withLocale(link.label, locale, editedLink.label),
          description: withOptionalLocale(
            link.description,
            locale,
            editedLink.description
          ),
        }
      }),
    }
  }
  if (block.kind === "featured" && edited.kind === "featured") {
    return {
      ...block,
      image:
        block.image && edited.image
          ? {
              ...block.image,
              alt: withAltLocale(
                block.image.alt,
                locale,
                edited.image.alt,
                (edited as typeof edited & AltPresence)[altPresence]
              ),
            }
          : undefined,
      link:
        block.link && edited.link
          ? {
              ...block.link,
              label: withLocale(block.link.label, locale, edited.link.label),
            }
          : undefined,
      heading: withLocale(block.heading, locale, edited.heading),
      description: withOptionalLocale(
        block.description,
        locale,
        edited.description
      ),
    }
  }
  if (block.kind === "dynamicList" && edited.kind === "dynamicList") {
    return {
      ...block,
      heading: withOptionalLocale(block.heading, locale, edited.heading),
      seeAll:
        block.seeAll && edited.seeAll
          ? {
              ...block.seeAll,
              label: withLocale(
                block.seeAll.label,
                locale,
                edited.seeAll.label
              ),
            }
          : undefined,
    }
  }
  throw new Error("Localized menu block kinds must match")
}

/**
 * Merge only locale-owned text leaves. Shared IDs, order, targets, images,
 * spans, disabled state, and every other locale bag remain byte-for-byte
 * owned by the canonical tree.
 */
export function mergeLocale(
  nav: readonly NavItem[],
  locale: string,
  edited: readonly LocaleNavItem[]
): NavItem[] {
  requireMatchingSharedShape(nav, edited)
  return nav.map((item, itemIndex) => {
    const editedItem = edited[itemIndex]
    if (!editedItem || editedItem.id !== item.id) {
      throw new Error("Localized menu item IDs and order must match")
    }
    const editedBlocks = new Map(
      panelBlocks(editedItem.panel).map((entry) => [
        entry.block.id,
        entry.block,
      ])
    )
    const panel =
      item.panel && editedItem.panel
        ? mapPanelBlocks(item.panel, (values) =>
            values.map((block) =>
              mergeBlockLocale(block, editedBlocks.get(block.id)!, locale)
            )
          )
        : undefined
    if (
      panel &&
      isColumnPanel(panel) &&
      editedItem.panel &&
      isColumnPanel(editedItem.panel)
    ) {
      panel.title = withOptionalLocale(
        panel.title,
        locale,
        editedItem.panel.title
      )
      panel.description = withOptionalLocale(
        panel.description,
        locale,
        editedItem.panel.description
      )
    }
    return {
      ...item,
      label: withLocale(item.label, locale, editedItem.label),
      panel,
    }
  })
}

function defaultBag(
  existing: L10n | undefined,
  defaultLocale: string,
  text: string
): L10n {
  return withLocale(existing ?? {}, defaultLocale, text)
}

function optionalDefaultBag(
  existing: L10n | undefined,
  defaultLocale: string,
  text: string | undefined
): L10n | undefined {
  const next = { ...(existing ?? {}) }
  if (!text?.trim()) delete next[defaultLocale]
  else next[defaultLocale] = text
  return Object.keys(next).length > 0 ? next : undefined
}

function replaceDefaultBlock(
  edited: LocaleBlock,
  existing: Block | undefined,
  existingLinks: ReadonlyMap<string, NavLink>,
  defaultLocale: string
): Block {
  if (existing && existing.kind !== edited.kind)
    throw new Error("Use a new block to change its kind")
  if (edited.kind === "linkGroup") {
    const existingGroup = existing?.kind === "linkGroup" ? existing : undefined
    return {
      id: edited.id,
      kind: "linkGroup",
      ...(edited.span !== undefined ? { span: edited.span } : {}),
      ...(optionalDefaultBag(
        existingGroup?.heading,
        defaultLocale,
        edited.heading
      ) !== undefined
        ? {
            heading: optionalDefaultBag(
              existingGroup?.heading,
              defaultLocale,
              edited.heading
            ),
          }
        : {}),
      links: edited.links.map((link) => {
        const existingLink = existingLinks.get(link.id)
        return {
          id: link.id,
          label: defaultBag(existingLink?.label, defaultLocale, link.label),
          ...(optionalDefaultBag(
            existingLink?.description,
            defaultLocale,
            link.description
          ) !== undefined
            ? {
                description: optionalDefaultBag(
                  existingLink?.description,
                  defaultLocale,
                  link.description
                ),
              }
            : {}),
          ...(link.icon !== undefined ? { icon: link.icon } : {}),
          target: link.target,
          ...(link.isDisabled !== undefined
            ? { isDisabled: link.isDisabled }
            : {}),
        }
      }),
    }
  }

  if (edited.kind === "dynamicList") {
    const existingDynamic =
      existing?.kind === "dynamicList" ? existing : undefined
    const heading = optionalDefaultBag(
      existingDynamic?.heading,
      defaultLocale,
      edited.heading
    )
    return {
      id: edited.id,
      kind: "dynamicList",
      ...(edited.span !== undefined ? { span: edited.span } : {}),
      ...(heading !== undefined ? { heading } : {}),
      source: edited.source,
      ...(edited.seeAll
        ? {
            seeAll: {
              label: defaultBag(
                existingDynamic?.seeAll?.label,
                defaultLocale,
                edited.seeAll.label
              ),
              target: edited.seeAll.target,
            },
          }
        : {}),
    }
  }

  const existingFeatured = existing?.kind === "featured" ? existing : undefined
  const { alt, ...sharedImage } = edited.image ?? { alt: "" }
  return {
    id: edited.id,
    kind: "featured",
    ...(edited.span !== undefined ? { span: edited.span } : {}),
    image: edited.image
      ? {
          ...sharedImage,
          alt: withAltLocale(
            existingFeatured?.image?.alt ?? {},
            defaultLocale,
            alt,
            (edited as typeof edited & AltPresence)[altPresence] ??
              (existingFeatured ? undefined : true)
          ),
        }
      : undefined,
    heading: defaultBag(
      existingFeatured?.heading,
      defaultLocale,
      edited.heading
    ),
    ...(optionalDefaultBag(
      existingFeatured?.description,
      defaultLocale,
      edited.description
    ) !== undefined
      ? {
          description: optionalDefaultBag(
            existingFeatured?.description,
            defaultLocale,
            edited.description
          ),
        }
      : {}),
    target: edited.target,
    link: edited.link
      ? {
          ...edited.link,
          label: defaultBag(
            existingFeatured?.link?.label,
            defaultLocale,
            edited.link.label
          ),
        }
      : undefined,
  }
}

/**
 * Replace the default locale's shared structure and text while carrying
 * translations forward only for nodes that retain the same stable ID.
 */
export function replaceDefaultLocale(
  nav: readonly NavItem[],
  defaultLocale: string,
  edited: readonly LocaleNavItem[]
): NavItem[] {
  const baseline = menuConversionBaseline(nav, edited)
  const existingItems = new Map(baseline.map((item) => [item.id, item]))
  const existingBlocks = new Map(
    baseline.flatMap((item) =>
      panelBlocks(item.panel).map(({ block }) => [block.id, block] as const)
    )
  )
  const existingLinks = new Map(
    baseline.flatMap((item) =>
      panelBlocks(item.panel).flatMap(({ block }) =>
        block.kind === "linkGroup"
          ? block.links.map((link) => [link.id, link] as const)
          : []
      )
    )
  )
  return edited.map((item) => {
    const existing = existingItems.get(item.id)
    const mapped =
      item.panel &&
      mapPanelBlocks(item.panel, (values) =>
        values.map((block) =>
          replaceDefaultBlock(
            block,
            existingBlocks.get(block.id),
            existingLinks,
            defaultLocale
          )
        )
      )
    const oldPanel =
      existing?.panel && isColumnPanel(existing.panel)
        ? existing.panel
        : undefined
    const panel =
      mapped && isColumnPanel(mapped)
        ? {
            ...mapped,
            title: optionalDefaultBag(
              oldPanel?.title,
              defaultLocale,
              mapped.title
            ),
            description: optionalDefaultBag(
              oldPanel?.description,
              defaultLocale,
              mapped.description
            ),
          }
        : mapped

    return {
      id: item.id,
      label: defaultBag(existing?.label, defaultLocale, item.label),
      ...(item.target !== undefined ? { target: item.target } : {}),
      ...(panel ? { panel } : {}),
      ...(item.isDisabled !== undefined ? { isDisabled: item.isDisabled } : {}),
    }
  })
}
