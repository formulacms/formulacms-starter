import { ConvexError } from "convex/values"
import {
  isColumnPanel,
  menuConversionBaseline,
  panelBlocks,
  mapPanelBlocks,
  type Block,
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
  const mapped = mapPanelBlocks(panel, (blocks) => blocks.map(sharedBlock))
  if (!isColumnPanel(mapped)) return mapped
  const { title: _title, description: _description, ...shape } = mapped
  void _title
  void _description
  return shape
}

function sharedBlock(block: Block) {
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
  const image =
    block.image &&
    Object.fromEntries(
      Object.entries(block.image).filter(([key]) => key !== "alt")
    )
  return {
    id: block.id,
    kind: block.kind,
    span: block.span,
    image,
    target: block.target,
    link: block.link ? { target: block.link.target } : undefined,
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
        panelBlocks(item.panel).map(
          ({ block }) => [block.id, block.kind] as const
        )
      )
    )
    for (const item of next)
      for (const { block } of panelBlocks(item.panel))
        if (kinds.has(block.id) && kinds.get(block.id) !== block.kind)
          reject("Use a new block to change its kind")
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
