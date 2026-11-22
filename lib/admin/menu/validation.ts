import {
  isColumnPanel,
  panelSections,
  type LocaleNavItem,
  type NavItem,
  type Target,
} from "@/convex/lib/menu"
import { menuTextLeaves } from "@/convex/lib/menu/canonical"
import { guardOutboundUrl, OutboundUrlError } from "@/convex/lib/urlGuard"

export type TargetIntent = Target["type"] | "none"
export type MenuFieldError = {
  key: string
  itemId: string
  sectionId?: string
  code: "url" | "page" | "image"
}

export function targetError(target: Target | undefined, intent?: TargetIntent) {
  if (
    (intent ?? target?.type) === "internal" &&
    (target?.type !== "internal" || !target.pageId)
  )
    return "page"
  if (target?.type !== "external") return undefined
  try {
    guardOutboundUrl(target.url)
  } catch (error) {
    if (error instanceof OutboundUrlError) return "url"
    throw error
  }
  return undefined
}

/** Validate all authored destinations, including collapsed rows and both regions. */
export function menuErrors(
  nav: LocaleNavItem[],
  intents: Record<string, TargetIntent> = {}
): MenuFieldError[] {
  const errors: MenuFieldError[] = []
  for (const item of nav) {
    function check(key: string, target: Target | undefined, sectionId?: string) {
      const code = targetError(target, intents[key])
      if (code) errors.push({ key, itemId: item.id, sectionId, code })
    }
    check(item.id, item.target)
    for (const { section } of panelSections(item.panel)) {
      if (section.kind === "linkGroup") {
        for (const link of section.links) check(link.id, link.target, section.id)
      } else if (section.kind === "dynamicList") {
        if (section.seeAll)
          check(`${section.id}-seeAll`, section.seeAll.target, section.id)
      } else {
        if (section.image && !section.image.url && !section.image.storageId)
          errors.push({
            key: `${section.id}-image`,
            itemId: item.id,
            sectionId: section.id,
            code: "image",
          })
        check(section.id, section.target, section.id)
        if (section.link) check(`${section.id}-link`, section.link.target, section.id)
      }
    }
  }
  return errors
}

export function hasMenuText(nav: LocaleNavItem[]): boolean {
  return nav.some(
    (item) =>
      Boolean(item.label.trim()) ||
      (item.panel &&
        isColumnPanel(item.panel) &&
        Boolean(item.panel.title?.trim() || item.panel.description?.trim())) ||
      panelSections(item.panel)
        .map((entry) => entry.section)
        .some(
          (section) =>
            Boolean(section.heading?.trim()) ||
            (section.kind === "featured" &&
              Boolean(
                section.description?.trim() ||
                section.image?.alt.trim() ||
                section.link?.label.trim()
              )) ||
            (section.kind === "linkGroup" &&
              section.links.some((link) =>
                Boolean(link.label.trim() || link.description?.trim())
              )) ||
            (section.kind === "dynamicList" &&
              Boolean(section.seeAll?.label.trim()))
        )
  )
}

/** Symbols carrying authored empty alt intent are meaningful editor state. */
export function menuDraftEqual(
  left: LocaleNavItem[],
  right: LocaleNavItem[]
): boolean {
  return (
    JSON.stringify(left, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? {
            ...value,
            ...Object.fromEntries(
              Object.getOwnPropertySymbols(value).map((symbol) => [
                `$${symbol.description}`,
                value[symbol],
              ])
            ),
          }
        : value
    ) ===
    JSON.stringify(right, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? {
            ...value,
            ...Object.fromEntries(
              Object.getOwnPropertySymbols(value).map((symbol) => [
                `$${symbol.description}`,
                value[symbol],
              ])
            ),
          }
        : value
    )
  )
}

/** Validate text on the canonical payload, so existing other-locale text counts. */
export function menuTextValid(nav: readonly NavItem[]): boolean {
  return menuTextLeaves(nav).every(
    (leaf) =>
      leaf.kind === "optional" ||
      (leaf.kind === "alt"
        ? Object.keys(leaf.bag ?? {}).length > 0
        : Object.values(leaf.bag ?? {}).some((text) => text.trim().length > 0))
  )
}
