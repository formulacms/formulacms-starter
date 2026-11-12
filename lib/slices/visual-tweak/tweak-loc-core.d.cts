export type TweakClassLiteral = {
  start: number
  end: number
  value: string
  quote: string
}

export type TweakClassNameShape =
  | { kind: "none" }
  | {
      kind: "literal"
      attributeStart: number
      attributeEnd: number
      literal: TweakClassLiteral
    }
  | {
      kind: "cn"
      attributeStart: number
      attributeEnd: number
      callClose: number
      literals: TweakClassLiteral[]
    }
  | {
      kind: "unsupported"
      attributeStart: number
      attributeEnd: number
    }

export type TweakLocationEntry = {
  loc: string
  file: string
  line: number
  column: number
  tag: string
  start: number
  end: number
  insertAttributeAt: number
  templateWide: boolean
  /** Conservative binding for a directly rendered primary leaf. */
  contentPath?: string
  /** Qualified runtime slice.items.map index from an explicit helper path. */
  contentPathExpression?: string
  className: TweakClassNameShape
}

export function enumerateTweakLocations(
  source: string,
  file: string
): TweakLocationEntry[]
