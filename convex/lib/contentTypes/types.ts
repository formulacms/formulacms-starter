import type { GenericValidator, ObjectType, VObject } from "convex/values"
import type { Id } from "../../_generated/dataModel"
import type { Primitive } from "../slices/primitives"

/**
 * Content-type descriptor registry — the C1 seam of plan 028.
 *
 * A content type = **code-first typed field schema** + **universal
 * referencability** (via the C2 `relation()` primitive) + **capability flags**.
 * The old "collection vs page" split is retired: whether an instance has a URL
 * is per-type config (`routing.pathPrefix`), not a different storage system.
 * Every content type lives on the `pages` table (storage name retained by
 * decision #6 of plan 028) and is discriminated by the `pageType` column.
 *
 * The descriptor shape mirrors the slice registry (`convex/lib/slices/`) —
 * declarative primitives on one side (so the schema-driven editor, sample
 * generator, and write-path validators can walk them uniformly), fully-formed
 * `v.object({ ... })` validators on the other (so the schema pulls a precise
 * discriminated union arm per type with no `v.any()`; ADR-003).
 *
 * This file defines the *shape* only. The registry (`./index.ts`), the
 * page-schema union rewrite, and the permission generation extension arrive in
 * the same C1 chunk once the shape is owner-approved. Written up in ADR-0037.
 */

// ─── Shared value types ───────────────────────────────────────────────────

/**
 * Central resolver output — the compact "who is this document" card that
 * relation pickers, back-reference lists, menus, JSON-LD generators, and
 * breadcrumbs all consume. Locale-scoped so localized titles/subtitles resolve
 * to the caller's requested locale; falls back per descriptor implementation.
 *
 * `href` is populated only when the target is routable AND currently
 * published — draft/archived non-routable rows resolve to a card without a
 * URL, which is what powers the "available to be referenced" semantics of
 * `published` for non-routable types (plan 028 §C1/C2 decision #4).
 */
export type ReferenceCard = {
  id: Id<"pages">
  type: string
  title: string
  /** Code-owned fallback only; UI may translate without changing owner text. */
  titleFallback?: "untitled"
  subtitle?: string
  href?: string
  imageMediaId?: Id<"media">
  /**
   * Editorial highlight flag. Optional — most types omit it. Post sets it
   * from the descriptor's `featured` shared field so downstream card
   * renderers can show a "Featured" badge. Plan 029 C10, ADR-0038 §Q9.b.
   */
  featured?: boolean
}

/**
 * A single descriptor field — a primitive descriptor from the slice registry's
 * `Primitive<V>` shape (ADR-008), reused verbatim so field editing / sample
 * generation / rich-text profile enforcement flow through one code path across
 * slices, page metadata, and content-type documents.
 */
export type DescriptorField = Primitive<GenericValidator>

/**
 * A map of descriptor fields, keyed by field name. Each descriptor declares
 * two: `sharedFields` (locale-agnostic, live at the row root) and
 * `localizedFields` (per-locale, live under `content[locale]`). Emptiness is
 * allowed — a pure-locale type (faq-item / testimonial) has empty
 * `sharedFields`; a locale-agnostic reference target might have empty
 * `localizedFields`.
 */
export type DescriptorFieldMap = Record<string, DescriptorField>

// ─── Capability set ───────────────────────────────────────────────────────

/**
 * Capability flags gate which *optional* pipeline surfaces a type opts into.
 *
 * Two of these — `sliceBody` and `scheduling` — shape the storage schema:
 * their fields only exist on a descriptor's union arm when the flag is on.
 * The other two — `revisions` and `presence` — gate **pipeline behavior**
 * (whether a revision row is written, whether presence/locks are tracked),
 * not schema shape.
 *
 * Fields that every current content type shares — hierarchy (`parentId` /
 * `ancestryPath` / `siblingOrder` / `parentSectionIds`), the SEO block,
 * post-listing card surface (`cardImageMediaId` / `cardExcerpt` /
 * `showOnHomepage` / `displayMode`) — remain in the shared row shape rather
 * than being capability-gated on the schema. They are optional across the
 * board today and no current type structurally forbids them. The plan's
 * "junk drawer dissolved" applies specifically to `authorId` and related
 * post-only fields.
 *
 * Every flag defaults to `false` for a new descriptor — types opt IN to
 * complexity, not the other way around.
 */
export type ContentTypeCapabilities = {
  /**
   * `content[locale].slices[]` — long-form slice-composed body. The three
   * current page-type flavors all set this; a pure reference target
   * (faq-item, testimonial) sets it to `false` and the union arm loses the
   * `slices` field entirely.
   *
   * SCHEMA-SHAPING.
   */
  sliceBody: boolean

  /**
   * Whether `pageRevisions` rows are written on save/publish. Non-revisioned
   * types skip the write (and skip the ADR-0029 archival-JSON path);
   * revision-restore paths tolerate absence.
   *
   * Pipeline behavior; does not shape the row schema (revision rows live in
   * their own table).
   */
  revisions: boolean

  /**
   * Whether `scheduledAt` / `expiresAt` and the scheduled-transition cron
   * fan out to this type. Off ⇒ those fields don't exist on the arm and the
   * scheduling cron's per-type webhook body skips it.
   *
   * SCHEMA-SHAPING.
   */
  scheduling: boolean

  /**
   * Whether `pagePresence` + `pageEditorLocks` are maintained for editors of
   * this type. Off for one-shot reference targets that don't warrant lock
   * choreography.
   *
   * Pipeline behavior; does not shape the row schema (presence/locks live in
   * their own tables).
   */
  presence: boolean

  /**
   * Publish contract (plan 029 C10, ADR-0038 §7): when `true`, the C9a
   * publish-checklist walker requires at least one meaningful enabled slice
   * on the arm and emits `missing_required_field: "body"` when empty. Off
   * ⇒ an empty slice canvas is a legitimate publish state.
   *
   * `sliceBody: false` types (testimonial) don't have a slice canvas — this
   * flag is n/a for them (kept `false`).
   *
   * Pipeline behavior; does not shape the row schema.
   */
  requiresBodyContent: boolean
}

// ─── The descriptor itself ────────────────────────────────────────────────

/**
 * A content-type descriptor. Registered in `./index.ts`; the schema, the
 * permission generator, the New-Page dialog, the sidebar Content group, the
 * pages-list filters, the command palette, and the C2 relation picker all
 * derive their type surface from the registered set.
 *
 * Per plan 028 decision #7, `type` is **immutable post-creation** — the
 * mutation layer enforces this; typed union arms can't survive a type flip
 * anyway. "Convert" is an explicit copy operation, not an in-place mutation.
 */
export type ContentTypeDescriptor<
  Shared extends DescriptorFieldMap = DescriptorFieldMap,
  Localized extends DescriptorFieldMap = DescriptorFieldMap,
> = {
  /** Stable slug, kebab-case. Same as the persisted `pageType` value. */
  type: string

  /**
   * Admin-facing labels. `singular` and `plural` are separate to give the
   * registry a single point of vocabulary control — the New-Page dialog, the
   * pages-list heading, the sidebar Content group entry, and permission
   * resource labels all pull from here. Deliberately not localized in
   * descriptor code (ADR-0011 §UI localisation): the admin UI translates
   * labels via the dictionary at consumption time.
   */
  label: {
    singular: string
    plural: string
  }

  /**
   * Locale-agnostic row-level fields. Live at the top of a `pages` document.
   * Descriptors compose the built-in system fields (slug/status/timestamps)
   * with type-specific declarations here (author `name` + `socials`, post
   * `authorId` byline pointer, etc.).
   *
   * `slug` is NOT declared here — it is a system field (all types have one),
   * with per-type requiredness driven by `routing`:
   *   - routable types (`routing.pathPrefix` present): slug required + unique
   *   - non-routable types: slug is optional identity, still unique when set
   *     but the type is addressed by relation, not URL (decision #5).
   */
  sharedFields: Shared

  /**
   * Per-locale fields. Live under `content[<locale>]` on a `pages` document
   * for parity with existing row shape. Empty ⇒ a locale-agnostic type; the
   * `content` map on the arm degrades to an empty object rather than
   * disappearing (keeps read paths simple).
   *
   * Localized rich-text fields inherit their profile from the primitive
   * (ADR-0009); the write-path validator already walks primitive descriptors
   * (see `convex/lib/slices/validate.ts`) — the C1 follow-up will point it at
   * content-type descriptors too, so profile enforcement covers author bios
   * and faq answers on the same code path that covers slice rich-text today.
   */
  localizedFields: Localized

  /**
   * Precomputed `v.object({...})` validators corresponding to
   * `sharedFields` / `localizedFields`. Descriptors must expose them so the
   * page-schema generator can build the per-type discriminated arm without
   * re-deriving them from `Primitive.validator` at runtime. Mirrors the
   * slice-descriptor pattern (`heroAgencyDef.validator`).
   *
   * Type parameters keep `Infer<>` precise per descriptor — no `v.any()`.
   */
  sharedValidator: VObject<
    ObjectType<{ [K in keyof Shared]: Shared[K]["validator"] }>,
    { [K in keyof Shared]: Shared[K]["validator"] }
  >
  localizedValidator: VObject<
    ObjectType<{ [K in keyof Localized]: Localized[K]["validator"] }>,
    { [K in keyof Localized]: Localized[K]["validator"] }
  >

  /**
   * Routing config. Absent ⇒ the type is non-routable (addressed only by
   * relation, does not appear in the sitemap, does not gain a public
   * renderer entry). Present ⇒ the type is routable at
   * `<locale>/<pathPrefix>/<slug>`; `pathPrefix` acts as a virtual root so
   * this type opts OUT of `hierarchy` (decision #6). Cross-prefix slug
   * collisions are prevented by mutation-layer uniqueness scoped per prefix.
   */
  routing?: {
    /**
     * URL segment mounted immediately under the locale (e.g. `""` for the
     * generic page root, `"posts"` for blog posts, `"authors"` for author
     * profiles). Empty string is legal — the current `page` type occupies
     * the root. The router (C3) reads this to disambiguate the wildcard
     * `[[...path]]` catch-all.
     */
    pathPrefix: string
  }

  /**
   * SEO type mapping consumed by the public renderer's JSON-LD `@type` and
   * Open Graph `og:type` outputs (see `convex/lib/contentTypes/routing.ts`
   * `seoTypesForContentType`). Absent ⇒ defaults `WebPage` / `website` —
   * the shape landing-page and page use. `post` sets `Article` / `article`.
   * C5's author descriptor will set `Person` / `profile` here rather than
   * branching on `pageType` string checks in the renderer.
   *
   * `ogType` is intersected against Next's `OpenGraph.type` union at the
   * consumer boundary — kept as a narrow union here so C5's author = `profile`
   * lands with a single descriptor edit and no runtime cast site to update.
   */
  seo?: {
    schemaOrgType?: string
    ogType?: "website" | "article" | "profile"
  }

  /** Capability flags — see {@link ContentTypeCapabilities}. */
  capabilities: ContentTypeCapabilities

  /**
   * Central reference-card resolver. Called by the C2 relation picker, the
   * back-reference list surfaces, menus, JSON-LD generators, and admin
   * search. Receives a pre-loaded Convex document (the caller decides
   * status/scope filtering) and the caller's locale so localized card
   * titles resolve correctly.
   *
   * The document is typed as an opaque `{ readonly _id: Id<"pages">; readonly
   * pageType: string; readonly ...unknown }` here because per-arm types
   * aren't statically known at registry-build time; concrete descriptor
   * implementations narrow with a runtime `pageType` check and cast (mirrors
   * how slice validators recover their primary/items types today). C2 wires
   * a helper `resolveReferenceCard(ctx, docId, locale)` that picks the right
   * descriptor and calls this.
   *
   * NOTE: `href` in the returned card must be omitted if the target isn't
   * published or the type is non-routable — see plan 028 decision #4
   * ("Never leak drafts through a published page's relations").
   */
  referenceCard: (
    doc: { readonly _id: Id<"pages">; readonly pageType: string } & Record<
      string,
      unknown
    >,
    locale: string
  ) => ReferenceCard

  /**
   * Optional AI hint co-located on the descriptor, mirroring the slice
   * registry's `AIHint` (ADR-0014).
   *
   * **Dormant seam — nothing reads this yet.** The slice-side `aiHint` is
   * live: `convex/lib/agents/contentWriterContract.ts` and
   * `convex/lib/help/workflow.ts` both build prompts from it, and
   * `slices/aiHint.test.ts` requires every slice to carry one. The
   * content-type side has no such consumer, so a descriptor that omits this
   * loses nothing and a descriptor that fills it in changes no behaviour.
   *
   * Recorded here rather than deleted because the AI outline surface is the
   * obvious future consumer and the shape should not have to be re-derived.
   * Left optional deliberately: making it required would oblige every new
   * descriptor to write prose that nothing reads. If you wire a consumer,
   * delete this paragraph and add the coverage test the slice side has.
   */
  aiHint?: {
    purpose: string
    fields: string
  }
}
