import { isColumnPanel, type PanelTree } from "../convex/lib/menu"

/** Assert fixture shape at runtime while retaining its canonical or locale blocks. */
export function expectLegacyPanel<B, L>(panel: PanelTree<B, L> | undefined) {
  if (!panel || isColumnPanel(panel))
    throw new Error("Expected a legacy panel fixture")
  return panel
}
