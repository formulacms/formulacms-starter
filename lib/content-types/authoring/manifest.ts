export type ContentTypeRendererKind =
  | "default-slice-body"
  | "custom-slice-body"
  | "custom-pure-form"
  | "none"

export type ContentTypeManifestEntry = {
  type: string
  module: string
  exportName: string
  labels: Record<string, { singular: string; plural: string }>
  selected: boolean
  sliceBody: boolean
  pathPrefix?: string
  renderer: ContentTypeRendererKind
  rendererModule?: string
  rendererExport?: string
  sharedFieldKeys: string[]
  localizedFieldKeys: string[]
}
