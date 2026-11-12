/** Replaced by Next's webpack callback, or by `compiler.define` in Turbopack development, for both editor and frame bundles. */
declare const __FORMULACMS_PREVIEW_BUILD_ID__: string
export const PREVIEW_BUILD_ID =
  typeof __FORMULACMS_PREVIEW_BUILD_ID__ === "string"
    ? __FORMULACMS_PREVIEW_BUILD_ID__
    : ""
