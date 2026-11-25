/** Require the literal http(s) scheme and both slashes on a trimmed address. */
export function hasSiteAddressScheme(value: string): boolean {
  return /^https?:\/\//i.test(value)
}
