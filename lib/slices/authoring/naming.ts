/**
 * Slug case conversion for the authoring funnel.
 *
 * A slice type is a kebab-case slug (`hero-agency`) that the generated code
 * spells three ways: the descriptor export is camelCase (`heroAgency`), the
 * renderer component and its types are PascalCase (`HeroAgency`). Every module
 * that emits or excises generated code needs the same two conversions, and they
 * were re-typed in four of them — so a slug edge case (a digit after a dash, a
 * leading numeral) could be fixed in one and stay broken in the others.
 */

/** `hero-agency` → `heroAgency`. */
export function toCamel(type: string): string {
  return type.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())
}

/** `hero-agency` → `HeroAgency`. */
export function toPascal(type: string): string {
  const camel = toCamel(type)
  return camel.charAt(0).toUpperCase() + camel.slice(1)
}

/** `heroAgency` → `hero-agency`, the inverse of {@link toCamel}. */
export function fromCamel(value: string): string {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
}
