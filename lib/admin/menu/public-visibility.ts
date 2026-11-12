import {
  dynamicListSourceKey,
  isColumnPanel,
  mapPanelBlocks,
  panelBlocks,
  type ResolvedBlock,
  type CanonicalResolvedNavItem,
  type MenuCardsBySource,
  type PanelTree,
} from "@/convex/lib/menu"

import { targetError } from "@/lib/admin/menu/validation"

type Reason =
  | "Switched off"
  | "No address"
  | "No published items"
  | "Empty"
  | "parent hidden"
  | null
type Kind = "item" | "panel" | "column" | "block" | "link" | "seeAll" | "image"
export type MenuDecision = { kind: Kind; shown: boolean; reason: Reason }
type ResolvedTarget = NonNullable<CanonicalResolvedNavItem["target"]>
type ResolvedPanel = NonNullable<CanonicalResolvedNavItem["panel"]>

export type ShownTarget = ResolvedTarget & { url: string }
type ShownLink<T> = Omit<T, "target"> & { target: ShownTarget }
type LinkGroup = Extract<ResolvedBlock, { kind: "linkGroup" }>
type Featured = Extract<ResolvedBlock, { kind: "featured" }>
type DynamicList = Extract<ResolvedBlock, { kind: "dynamicList" }>
export type ShownBlock =
  | (Omit<LinkGroup, "links"> & {
      links: ShownLink<LinkGroup["links"][number]>[]
    })
  | (Omit<Featured, "target" | "link"> & {
      target?: ShownTarget
      link?: ShownLink<NonNullable<Featured["link"]>>
    })
  | (Omit<DynamicList, "seeAll"> & {
      seeAll?: ShownLink<NonNullable<DynamicList["seeAll"]>>
    })
export type ShownNavItem = Omit<CanonicalResolvedNavItem, "target" | "panel"> &
  (
    | { target: ShownTarget; panel?: undefined }
    | { target?: ShownTarget; panel: PanelTree<ShownBlock, string> }
  )

/**
 * Public visibility owns no language/publication reads: it consumes the resolved
 * locale tree and published cards. Missing text is already omitted upstream.
 * Anonymous leaves use parent-relative IDs (:panel, :link, :seeAll, :image).
 * Empty containers retain their children's own reasons; explicit ancestor
 * suppression wins over a descendant's own switch/address/content reason.
 */
export function decideMenu(
  items: CanonicalResolvedNavItem[],
  cardsBySource: MenuCardsBySource
): { items: ShownNavItem[]; nodes: Map<string, MenuDecision> } {
  const nodes = new Map<string, MenuDecision>()
  const put = (id: string, kind: Kind, reason: Reason) => {
    nodes.set(id, { kind, shown: reason === null, reason })
    return reason === null
  }
  const gate = (dead: boolean, own: Reason): Reason =>
    dead ? "parent hidden" : own
  const addressReason = (target?: ResolvedTarget): Reason => {
    if (!target?.url?.trim()) return "No address"
    return target.type === "external" && targetError(target)
      ? "No address"
      : null
  }
  const admitTarget = (
    target: ResolvedTarget | undefined,
    id: string,
    dead: boolean,
    kind: "link" | "seeAll" = "link"
  ): ShownTarget | undefined => {
    if (!target) return undefined
    if (!put(id, kind, gate(dead, addressReason(target)))) return undefined
    if (target.type === "internal") {
      const url = target.url
      return url === undefined ? undefined : { ...target, url }
    }
    return target
  }
  const link = <T extends { target: ResolvedTarget; isDisabled?: boolean }>(
    value: T,
    id: string,
    kind: "link" | "seeAll",
    dead: boolean
  ): ShownLink<T> | undefined => {
    if (value.isDisabled) {
      put(id, kind, gate(dead, "Switched off"))
      return undefined
    }
    const target = admitTarget(value.target, id, dead, kind)
    return target ? { ...value, target } : undefined
  }

  const block = (
    value: ResolvedBlock,
    dead: boolean
  ): ShownBlock | undefined => {
    const off = gate(dead, null)
    if (value.kind === "linkGroup") {
      const links = value.links
        .map((entry) => link(entry, entry.id, "link", dead))
        .filter((entry) => entry !== undefined)
      return put(value.id, "block", off ?? (links.length ? null : "Empty"))
        ? { ...value, links }
        : undefined
    }
    if (value.kind === "dynamicList") {
      const reason =
        off ??
        ((cardsBySource[dynamicListSourceKey(value.source)]?.length ?? 0)
          ? null
          : "No published items")
      const seeAll =
        value.seeAll &&
        link(value.seeAll, `${value.id}:seeAll`, "seeAll", reason !== null)
      return put(value.id, "block", reason) ? { ...value, seeAll } : undefined
    }
    // A card's destination is optional; only ancestor/disabled state can
    // suppress its content, image, and independently resolved Link.
    const { target: rawTarget, ...card } = value
    const target = admitTarget(rawTarget, `${value.id}:target`, dead)
    const featuredLink =
      value.link && link(value.link, `${value.id}:link`, "link", off !== null)
    if (value.image)
      put(`${value.id}:image`, "image", off ? "parent hidden" : null)
    if (!put(value.id, "block", off)) return undefined
    return { ...card, ...(target ? { target } : {}), link: featuredLink }
  }
  const panel = (
    value: ResolvedPanel,
    id: string,
    dead: boolean
  ): PanelTree<ShownBlock, string> | undefined => {
    let result = mapPanelBlocks(value, (blocks) =>
      blocks.flatMap((entry) => {
        const shown = block(entry, dead)
        return shown ? [shown] : []
      })
    )
    if (isColumnPanel(result)) {
      result = {
        ...result,
        columns: result.columns.filter((col) =>
          put(col.id, "column", gate(dead, col.blocks.length ? null : "Empty"))
        ),
      }
    }
    if (result.footer?.blocks.length === 0) delete result.footer
    return put(
      id,
      "panel",
      gate(dead, panelBlocks(result).length ? null : "Empty")
    )
      ? result
      : undefined
  }

  // Both launch surfaces keep panels. Footer-only suppression is deferred R2.
  const shown = items.flatMap((item): ShownNavItem[] => {
    const off: Reason = item.isDisabled ? "Switched off" : null
    const { target: rawTarget, ...value } = item
    const target = admitTarget(rawTarget, `${item.id}:target`, off !== null)
    const shownPanel =
      item.panel && panel(item.panel, `${item.id}:panel`, off !== null)
    const reason =
      off ?? (shownPanel || target ? null : item.panel ? "Empty" : "No address")
    if (!put(item.id, "item", reason)) return []
    if (shownPanel)
      return [{ ...value, ...(target ? { target } : {}), panel: shownPanel }]
    return target ? [{ ...value, target, panel: undefined }] : []
  })
  return { items: shown, nodes }
}
