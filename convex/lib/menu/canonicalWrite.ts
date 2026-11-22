import { ConvexError } from "convex/values"
import {
  isColumnPanel,
  menuConversionBaseline,
  panelSections,
  mapPanelSections,
  type PanelSection,
  type L10n,
  type NavItem,
} from "../menu"
import { menuTextLeaves, normalizeMenuTextBag } from "./canonical"

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)])
    )
  }
  return value
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right))
}

function sharedShape(nav: readonly NavItem[]): unknown {
  return nav.map((item) => ({
    id: item.id,
    target: item.target,
    isDisabled: item.isDisabled,
    panel: item.panel ? sharedPanel(item.panel) : undefined,
  }))
}

function sharedPanel(panel: NonNullable<NavItem["panel"]>) {
  const mapped = mapPanelSections(panel, (sections) =>
    sections.map(sharedSection)
  )
  if (!isColumnPanel(mapped)) return mapped
  const { title: _title, description: _description, ...shape } = mapped
  void _title
  void _description
  return shape
}

function sharedSection(section: PanelSection) {
  if (section.kind === "linkGroup") {
    return {
      id: section.id,
      kind: section.kind,
      span: section.span,
      links: section.links.map((link) => ({
        id: link.id,
        icon: link.icon,
        target: link.target,
        isDisabled: link.isDisabled,
      })),
    }
  }
  if (section.kind === "dynamicList") {
    return {
      id: section.id,
      kind: section.kind,
      span: section.span,
      source: section.source,
      seeAll: section.seeAll ? { target: section.seeAll.target } : undefined,
    }
  }
  const image =
    section.image &&
    Object.fromEntries(
      Object.entries(section.image).filter(([key]) => key !== "alt")
    )
  return {
    id: section.id,
    kind: section.kind,
    span: section.span,
    image,
    target: section.target,
    link: section.link ? { target: section.link.target } : undefined,
  }
}

function withoutLocale(value: L10n, locale: string): L10n {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== locale)
  )
}

function localeBags(nav: readonly NavItem[], omittedLocale: string) {
  const bags = new Map<string, L10n>()
  for (const leaf of menuTextLeaves(nav)) {
    const bag = withoutLocale(
      normalizeMenuTextBag(leaf.bag, leaf.kind),
      omittedLocale
    )
    if (Object.keys(bag).length > 0) bags.set(leaf.path, bag)
  }
  return bags
}

function reject(message: string): never {
  throw new ConvexError(message)
}

export function validateCanonicalWrite(
  existing: readonly NavItem[],
  next: readonly NavItem[],
  locale: string,
  defaultLocale: string
): void {
  for (const item of existing) {
    const nextPanel = next.find((candidate) => candidate.id === item.id)?.panel
    if (
      item.panel &&
      isColumnPanel(item.panel) &&
      nextPanel &&
      !isColumnPanel(nextPanel)
    )
      throw new Error("Menu changed format; reload the editor before saving")
  }
  if (
    locale !== defaultLocale &&
    !equal(sharedShape(existing), sharedShape(next))
  ) {
    reject("Non-default menu edits cannot change shared structure or targets")
  }

  if (locale === defaultLocale) {
    const kinds = new Map(
      existing.flatMap((item) =>
        panelSections(item.panel).map(
          ({ section }) => [section.id, section.kind] as const
        )
      )
    )
    for (const item of next)
      for (const { section } of panelSections(item.panel))
        if (kinds.has(section.id) && kinds.get(section.id) !== section.kind)
          reject("Use a new section to change its kind")
  }

  // The editor and server seed only converted featured Link labels from storage.
  const existingText = menuConversionBaseline(existing, next)
  const before = localeBags(existingText, locale)
  const after = localeBags(next, locale)
  if (locale !== defaultLocale) {
    if (!equal([...before.entries()].sort(), [...after.entries()].sort())) {
      reject("A menu locale edit cannot change another locale's text")
    }
    return
  }

  // A surviving node also owns fields omitted from the submitted payload.
  // Whole-node deletion remains a permitted default-language structure edit.
  const surviving = new Set(menuTextLeaves(next).map((leaf) => leaf.nodePath))
  for (const leaf of menuTextLeaves(existingText)) {
    const beforeBag = before.get(leaf.path)
    if (
      beforeBag &&
      surviving.has(leaf.nodePath) &&
      !equal(beforeBag, after.get(leaf.path) ?? {})
    ) {
      reject(
        `Default-language edits must preserve translations at ${leaf.path}`
      )
    }
  }

  for (const [path, afterBag] of after) {
    const beforeBag = before.get(path)
    if (beforeBag && !equal(beforeBag, afterBag)) {
      reject(`Default-language edits must preserve translations at ${path}`)
    }
    if (!beforeBag && Object.keys(afterBag).length > 0) {
      reject(`New menu nodes cannot introduce other-language text at ${path}`)
    }
  }
}
