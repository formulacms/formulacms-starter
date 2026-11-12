import {
  isColumnPanel,
  panelBlocks,
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
  blockId?: string
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
    function check(key: string, target: Target | undefined, blockId?: string) {
      const code = targetError(target, intents[key])
      if (code) errors.push({ key, itemId: item.id, blockId, code })
    }
    check(item.id, item.target)
    for (const { block } of panelBlocks(item.panel)) {
      if (block.kind === "linkGroup") {
        for (const link of block.links) check(link.id, link.target, block.id)
      } else if (block.kind === "dynamicList") {
        if (block.seeAll)
          check(`${block.id}-seeAll`, block.seeAll.target, block.id)
      } else {
        if (block.image && !block.image.url && !block.image.storageId)
          errors.push({
            key: `${block.id}-image`,
            itemId: item.id,
            blockId: block.id,
            code: "image",
          })
        check(block.id, block.target, block.id)
        if (block.link) check(`${block.id}-link`, block.link.target, block.id)
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
      panelBlocks(item.panel)
        .map((entry) => entry.block)
        .some(
          (block) =>
            Boolean(block.heading?.trim()) ||
            (block.kind === "featured" &&
              Boolean(
                block.description?.trim() ||
                block.image?.alt.trim() ||
                block.link?.label.trim()
              )) ||
            (block.kind === "linkGroup" &&
              block.links.some((link) =>
                Boolean(link.label.trim() || link.description?.trim())
              )) ||
            (block.kind === "dynamicList" &&
              Boolean(block.seeAll?.label.trim()))
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
