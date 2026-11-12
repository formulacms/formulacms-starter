/** Exact atomic adoptions only. Each row requires permanent conversion,
 * upcast defaults/samples and every registered presentation in the same change.
 * This registry never permits arbitrary narrowing or list relocation.
 */
type TitleMigration = {
  type: string
  path: string
  from: "inline" | "text"
  role: "sliceTitle" | "itemTitle"
  parent?: string
}
export const TITLE_MIGRATIONS: readonly TitleMigration[] = [
  {
    type: "site-search",
    path: "primary.heading",
    from: "inline",
    role: "sliceTitle",
  },
  {
    type: "hero-agency",
    path: "primary.title",
    from: "inline",
    role: "sliceTitle",
  },
  {
    type: "features-icon-grid",
    path: "primary.heading",
    from: "inline",
    role: "sliceTitle",
  },
  {
    type: "features-icon-grid",
    path: "items.title",
    from: "inline",
    role: "itemTitle",
    parent: "primary.heading",
  },
  {
    type: "contact-form",
    path: "primary.heading",
    from: "inline",
    role: "sliceTitle",
  },
  {
    type: "contact-form",
    path: "items.label",
    from: "inline",
    role: "itemTitle",
    parent: "primary.heading",
  },
  {
    type: "faq-simple",
    path: "primary.heading",
    from: "inline",
    role: "sliceTitle",
  },
  {
    type: "faq-simple",
    path: "items.question",
    from: "text",
    role: "itemTitle",
    parent: "primary.heading",
  },
]

export function isRegisteredTitleMigration(
  type: string,
  path: string,
  before: { kind: string; profile?: string },
  after: {
    kind: string
    profile?: string
    headingRole?: string
    headingParent?: string
  }
): boolean {
  return (
    after.kind === "richText" &&
    after.profile === "title" &&
    TITLE_MIGRATIONS.some(
      (entry) =>
        entry.type === type &&
        entry.path === path.replace(/^item\./, "items.") &&
        (entry.from === "text"
          ? before.kind === "text"
          : before.kind === "richText" && entry.from === before.profile) &&
        entry.role === after.headingRole &&
        entry.parent === after.headingParent
    )
  )
}
