/**
 * Descriptor shared fields that keep dedicated editor and mutation handling.
 *
 * Both the admin field fan and the Convex write seam consume this set so a
 * field cannot be rendered generically while the server still requires a
 * dedicated mutation argument.
 */
export const SYSTEM_OWNED_SHARED_FIELDS: ReadonlySet<string> = new Set([
  "tags",
  "authorIds",
])
