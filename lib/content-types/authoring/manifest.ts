export type ContentTypeRendererKind =
  | "default-block-body"
  | "custom-block-body"
  | "custom-pure-form"
  | "none"

export type ContentTypeManifestEntry = {
  type: string
  module: string
  exportName: string
  labels: Record<string, { singular: string; plural: string }>
  selected: boolean
  blockBody: boolean
  pathPrefix?: string
  renderer: ContentTypeRendererKind
  rendererModule?: string
  rendererExport?: string
  sharedFieldKeys: string[]
  localizedFieldKeys: string[]
}
