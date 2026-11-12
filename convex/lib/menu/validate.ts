import { ConvexError } from "convex/values"
import {
  MENU_ICON_NAMES,
  isColumnPanel,
  panelBlocks,
  type L10n,
  type NavItem,
  type Target,
} from "../menu"
import { menuTextLeaves } from "./canonical"
import { isActiveContentType } from "../contentTypes"
import { guardOutboundUrl } from "../urlGuard"

const MENU_ICON_NAME_SET = new Set<string>(MENU_ICON_NAMES)

function reject(message: string): never {
  throw new ConvexError(message)
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0
}

function requireDefaultText(
  value: L10n,
  defaultLocale: string,
  path: string,
  allowEmpty = false
): void {
  if (!Object.prototype.hasOwnProperty.call(value, defaultLocale)) {
    reject(`${path} must include the default language (${defaultLocale})`)
  }
  if (!allowEmpty && !hasText(value[defaultLocale])) {
    reject(`${path} must have non-blank default-language text`)
  }
}

function validateTarget(target: Target, path: string): void {
  if (target.type === "external") {
    if (!hasText(target.url)) reject(`${path} must have an external URL`)
    guardOutboundUrl(target.url)
  } else if (target.type === "anchor") {
    if (!hasText(target.anchor) || !target.anchor.startsWith("#")) {
      reject(`${path} must have a #page-anchor`)
    }
  }
}

function validateMenuStructure(nav: readonly NavItem[]): void {
  const ids = new Set<string>()
  const registerId = (id: string, path: string) => {
    if (!hasText(id)) reject(`${path} id must not be blank`)
    if (ids.has(id)) reject(`Menu contains duplicate id "${id}"`)
    ids.add(id)
  }

  for (const item of nav) {
    const itemPath = `nav[${item.id}]`
    registerId(item.id, itemPath)
    if (item.target) validateTarget(item.target, `${itemPath}.target`)

    const panel = item.panel
    if (panel && isColumnPanel(panel)) {
      const columns = panel.columns
      if (columns.length > 4) reject("A panel can have at most 4 columns")
      const ids = new Set<string>()
      for (const column of columns) {
        if (!hasText(column.id) || ids.has(column.id))
          reject("Panel column ids must be non-blank and unique")
        ids.add(column.id)
      }
    }
    for (const { block, path } of panelBlocks(panel)) {
      const blockPath = `${itemPath}.panel.${path}`
      if (panel && isColumnPanel(panel) && block.span !== undefined)
        reject("Column panel blocks cannot have a span")
      if (block.kind === "featured") {
        if (panel && isColumnPanel(panel) && block.target !== undefined)
          reject("Column featured blocks cannot have a card target")
        if (panel && !isColumnPanel(panel) && block.link !== undefined)
          reject("Legacy featured blocks cannot have a Link")
      }
      registerId(block.id, blockPath)
      if (block.kind === "linkGroup") {
        for (const link of block.links) {
          const linkPath = `${blockPath}.links[${link.id}]`
          registerId(link.id, linkPath)
          validateTarget(link.target, `${linkPath}.target`)
          if (link.icon && !MENU_ICON_NAME_SET.has(link.icon)) {
            reject(`${linkPath} uses unknown icon "${link.icon}"`)
          }
        }
        continue
      }

      if (block.kind === "dynamicList") {
        if (!isActiveContentType(block.source.pageType)) {
          reject(
            `${blockPath}.source.pageType must name an active content type`
          )
        }
        if (
          !Number.isInteger(block.source.limit) ||
          block.source.limit < 1 ||
          block.source.limit > 12
        ) {
          reject(`${blockPath}.source.limit must be an integer from 1 to 12`)
        }
        if (block.seeAll) {
          validateTarget(block.seeAll.target, `${blockPath}.seeAll.target`)
        }
        continue
      }

      if (
        block.image &&
        block.image.storageId === undefined &&
        !hasText(block.image.url)
      ) {
        reject(`${blockPath}.image must select an image`)
      }
      if (block.target) validateTarget(block.target, `${blockPath}.target`)
      if (block.link)
        validateTarget(block.link.target, `${blockPath}.link.target`)
    }
  }
}

/** Save validity is independent of the current default and enabled languages. */
export function validateCanonicalMenu(nav: readonly NavItem[]): void {
  validateMenuStructure(nav)
  for (const leaf of menuTextLeaves(nav)) {
    if (
      leaf.kind === "required" &&
      !Object.values(leaf.bag ?? {}).some(hasText)
    ) {
      reject(`${leaf.path} must have non-blank text in at least one language`)
    }
    if (leaf.kind === "alt" && Object.keys(leaf.bag ?? {}).length === 0) {
      reject(`${leaf.path} must include image alt in at least one language`)
    }
  }
}

/** F09 readiness retains the former strict per-locale rule, including headings. */
export function validateCanonicalMenuForLocale(
  nav: readonly NavItem[],
  locale: string
): void {
  validateMenuStructure(nav)
  for (const leaf of menuTextLeaves(nav)) {
    if (
      !leaf.strictLocale ||
      (leaf.kind === "optional" && leaf.bag === undefined)
    )
      continue
    requireDefaultText(leaf.bag ?? {}, locale, leaf.path, leaf.kind === "alt")
  }
}
