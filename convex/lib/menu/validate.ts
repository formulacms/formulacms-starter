import { ConvexError } from "convex/values"
import {
  MENU_ICON_NAMES,
  isColumnPanel,
  panelSections,
  type L10n,
  type NavItem,
  type Target,
} from "../menu"
import { menuTextLeaves } from "./canonical"
import { isActiveContentType } from "../contentTypes"
import { isContactHref } from "../linkSchemes"
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
    const url = target.url.trim()
    if (isContactHref(url)) return
    guardOutboundUrl(url)
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
    for (const { section, path } of panelSections(panel)) {
      const sectionPath = `${itemPath}.panel.${path}`
      if (panel && isColumnPanel(panel) && section.span !== undefined)
        reject("Column panel sections cannot have a span")
      if (section.kind === "featured") {
        if (panel && isColumnPanel(panel) && section.target !== undefined)
          reject("Column featured sections cannot have a card target")
        if (panel && !isColumnPanel(panel) && section.link !== undefined)
          reject("Legacy featured sections cannot have a Link")
      }
      registerId(section.id, sectionPath)
      if (section.kind === "linkGroup") {
        for (const link of section.links) {
          const linkPath = `${sectionPath}.links[${link.id}]`
          registerId(link.id, linkPath)
          validateTarget(link.target, `${linkPath}.target`)
          if (link.icon && !MENU_ICON_NAME_SET.has(link.icon)) {
            reject(`${linkPath} uses unknown icon "${link.icon}"`)
          }
        }
        continue
      }

      if (section.kind === "dynamicList") {
        if (!isActiveContentType(section.source.pageType)) {
          reject(
            `${sectionPath}.source.pageType must name an active content type`
          )
        }
        if (
          !Number.isInteger(section.source.limit) ||
          section.source.limit < 1 ||
          section.source.limit > 12
        ) {
          reject(`${sectionPath}.source.limit must be an integer from 1 to 12`)
        }
        if (section.seeAll) {
          validateTarget(section.seeAll.target, `${sectionPath}.seeAll.target`)
        }
        continue
      }

      if (
        section.image &&
        section.image.storageId === undefined &&
        !hasText(section.image.url)
      ) {
        reject(`${sectionPath}.image must select an image`)
      }
      if (section.target)
        validateTarget(section.target, `${sectionPath}.target`)
      if (section.link)
        validateTarget(section.link.target, `${sectionPath}.link.target`)
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
