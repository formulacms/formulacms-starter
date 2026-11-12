# Glossary

The glossary of formulacms: the only place where terms are defined. Owner rule (2026-11-04): "term deifinition should be recorded in GLOSSARY.md  never in CONTEXT.md  COMTEXT.md can refrence this document". [`CONTEXT.md`](CONTEXT.md) describes the product's content-authoring domain and refers here for every term; [`Identity.md`](Identity.md) holds the name, label and positioning.

Entry format: `**Term**:` on its own line, then the definition on the lines that follow, then an `_Avoid_:` line naming words not to use (some entries add an `_Important_:` or test line). Entries are grouped by section, in the order they were written.

## Content authoring language

**Page**:
A shared content identity that owns Page-wide structure and lifecycle and holds zero or more Localized Contents. A Page may be active with no published locale; publication belongs to Localized Content, never to the Page.
_Avoid_: Document, entry, node

**Home Page**:
The single Page assigned to the site's public root. Content for each enabled locale is independent. After a Default Language Change the Home Page may have no content in the new default locale until the owner writes and publishes it; nothing is created or substituted for it.
_Avoid_: Homepage record, root document

**Localized Content**:
The independently publishable per-locale unit of a Page (`fr`, `en`, …). Each locale carries its own `slices` array — slices are duplicated per locale, not shared — and archiving or trashing the Page removes every locale from public access.
_Avoid_: Translation, variant

**Working Draft**:
The single mutable authoring state of one Localized Content. Preview reads it; saving it never changes the public site, even when that locale has already been published.
_Avoid_: Draft Page, live content

**Shared Draft**:
The Page's single mutable authoring state for non-localized public fields. Publishing a locale combines its Working Draft with the current Shared Draft; changing shared fields marks published locales as out of date but publishes none of them automatically.
_Avoid_: Global publication, Page draft

**Published Snapshot**:
An immutable public version created atomically from a Localized Content's validated Working Draft and the Page's current Shared Draft. Public reads follow the complete snapshot; republishing creates and selects a new snapshot instead of consulting or mutating either draft.
_Avoid_: Published Page, live draft

**Public Projection**:
The locale-specific public read state derived only from the current Published Snapshot. It supplies public routes, search, navigation eligibility, and related outputs; draft saves never change it.
_Avoid_: Working Draft cache, live Page row

**Public Locale URL**:
A locale-specific route backed by that Localized Content's current Published Snapshot. Missing, draft-only, and withdrawn Localized Content never renders fallback content and is publicly indistinguishable through the same not-found response.
_Avoid_: Fallback URL, translated route without a Published Snapshot

**Public Language Switcher**:
The locale selector shown only when at least two locales are enabled. It links the current Page's published locales and visibly disables its unavailable locales without redirecting them elsewhere.
_Avoid_: Fallback navigation, Home redirect for an unavailable locale

**Indexable Published Locale**:
A Localized Content with a current Published Snapshot whose public SEO state permits indexing. Only these locale URLs participate in sitemap and hreflang discovery; publication without indexability remains publicly viewable.
_Avoid_: Published locale (when indexability matters), draft with `noindex`

**Public Link**:
A locale-specific internal reference whose target has a current Published Snapshot in that same locale. An unavailable target has no public `href`; it never falls through to another locale's URL.
_Avoid_: Fallback link, cross-locale substitute

**Published Ancestry**:
The chain of ancestor Pages whose matching Localized Contents all have current Published Snapshots. A child locale may be published only with complete same-locale Published Ancestry, which is also the sole source for its public path and breadcrumb.
_Avoid_: Draft ancestry, fallback breadcrumb

**Historical Locale URL**:
A former public path retained as a locale-scoped permanent redirect after publishing a path change. It resolves only while that same locale retains a current Published Snapshot and never redirects to another locale automatically.
_Avoid_: Fallback redirect, draft redirect

**Public Pageview**:
A successful render of one current Published Snapshot at its canonical Public Locale URL, identified by Page, locale, and snapshot. Preview activity, redirects, and unavailable-locale requests are not Public Pageviews.
_Avoid_: Preview view, redirect hit, fallback view

**Home Launch**:
The deliberate, locale-scoped publication action that validates one Home Working Draft and creates a new indexable Published Snapshot for that locale only. It never mutates the earlier `noindex` snapshot, launches another locale, or follows automatically from setup or domain configuration.
_Avoid_: Setup completion, domain connection, in-place index toggle

**Disabled Locale**:
An authoring locale reversibly suspended from every public surface without withdrawing or deleting its drafts, Published Snapshots, revisions, or URL history. Its public requests return not found until it is enabled again.
_Avoid_: Withdrawn locale, deleted translation, default-locale redirect

**Default Locale Migration**:
Being replaced by the Default Language Change (owner, 2026-11-02); still present until unit U7 removes it. The atomic change that makes another enabled locale the site's unprefixed URL locale and redirects every affected published locale URL to the same Page and locale at its new canonical path. It is not an ordinary settings edit and never substitutes content across locales. It has disclosed exceptions: a visible path the new default locale already claims serves the new default locale instead of redirecting, and manual redirect rules move with their locale's prefix rather than being copied. A redirect stops for good once a later publication claims its path.
_Avoid_: Default-locale toggle, cross-locale redirect

**Default Language Change**:
Planned (owner, 2026-11-02; arrives with unit U6). One owner action that makes another enabled language the site's unprefixed URL language. It needs no published home page in that language (owner, 2026-11-02). It has no review and no page or path changes. Until the new default language has a published home, `/` is unclaimed and resolves to a published home in another language. Old addresses of the previous default redirect temporarily (307) to the same page in the language the request resolved to when it is published there, otherwise to the page's own language. It never substitutes content across languages.
_Avoid_: Default-locale toggle, cross-locale redirect

**Site Language Change**:
One owner action when the site has one public language. It changes the language tags and the site's built-in words, never what the owner wrote, and applies at once after one confirmation (owner, 2026-11-05).
_Avoid_: Language transition, preparation, readiness check

**Language Operation**:
A change to which languages the site offers or which one is the default: a single-language change, a Default Locale Migration (a Default Language Change once unit U6 ships), turning the Multilingual module on or off, adopting multilingual mode, adding, revealing or removing a language, or returning to one language. At most one long-running operation, a single-language change or a Default Locale Migration, is open at a time; the others complete in one step. A Default Language Change will complete in one step (owner, 2026-11-02).
_Avoid_: Settings edit, locale toggle

**Continuity Generation**:
Being retired by the public routing plan (owner, 2026-11-02); still present until unit U7 removes it. One complete capture of the old visible paths a Default Locale Migration keeps working, each mapped to the same Page and the locale that served it when captured. Restarting the capture creates a new generation; generations never mix, and activation makes exactly one generation the active set.
_Avoid_: Redirect list, manual redirect rules, Historical Locale URL

**Review Receipt**:
The record that the owner's signed-in session retrieved every disclosure page of one language impact preview, or of one Continuity Generation, in order and unchanged. Removing a language, revealing a language's retained public content and activating a Default Locale Migration each require one. A Default Language Change will not (owner, 2026-11-02). It proves the pages were retrieved, not that a person read them.
_Avoid_: Approval, consent, acknowledgement checkbox

**Crawler Policy**:
The owner-visible rules that independently govern search-discovery crawlers, user-triggered agents, and model-training or grounding crawlers. It applies only to public Published Snapshots and is never an authorization or confidentiality boundary.
_Avoid_: Access control, one wildcard AI-bot switch, `llms.txt` policy

**Withdrawal**:
The removal of one locale's current Published Snapshot from public access without deleting its Working Draft or publication history. A scheduled Withdrawal names the exact snapshot it may withdraw, so it cannot remove a newer publication accidentally.
_Avoid_: Archive, delete, unpublish the Page

**Scheduled Publication**:
A future publication of one locale from an immutable candidate frozen from its Working Draft when scheduled. Later draft edits do not alter the candidate; replacing or cancelling the schedule makes its former job ineligible to publish.
_Avoid_: Publish the latest draft later, Page schedule

**Draft Revision**:
An append-only historical snapshot. The inherited source captures explicit publish, scheduled publish, and scheduled expiry, and its still-active `pages.update` path records `manual_save` when status, direct content, or SEO changes; current archive and restore-to-draft controls use that status path. Ordinary Working Draft saves through `updateDraft` and `restoreRevisionAsDraft` do not create a Draft Revision. Restoring a revision copies its content into staging without rewriting history, changing the revision count, or changing a Published Snapshot; a later publish may capture the outgoing public state. F08 and M06 own the successor disposition of `manual_save`; P01 does not call it retired or read-only.
_Avoid_: Published Snapshot, rollback in place

**Preview Session**:
A short-lived, authenticated view of one Page's saved Working Draft in one locale. It is bound to the viewer, Page identity, and locale; browser draft mode or knowledge of a slug is not authority to read unpublished content.
_Avoid_: Public preview link, Draft Mode cookie, preview URL

**Slice**:
A composable, typed content block placed in a Localized Content's ordered list (for example `hero` or `hero-agency`). Has `id`, `type`, `enabled`, a `primary` field group, and optional repeatable `items`.
_Avoid_: Block, section, widget, component, Prismic slice, Slice Machine slice
_Important_: This is formulacms vocabulary only. A Slice is not a Prismic model,
custom type, shared slice, or Slice Machine artifact.

**Slice Type**:
The reusable code-first definition from which Slice instances are created, combining the content shape with its renderer and authoring metadata. Archiving or deleting a Slice Type is distinct from removing one Slice from a Page.
_Avoid_: Example Slice (when meaning the reusable type), Slice instance

**Field Primitive**:
The smallest reusable authoring unit a Slice is built from. The v0.1 vocabulary is fixed at seven leaf kinds: **text, rich-text, image, link, boolean, select, number**. A primitive holds a single value within one locale — localization lives one level up at the Page, never inside a primitive — and always has a value (a canonical default); "unset" is expressed only by omitting an explicitly-optional field, never by a half-set or tri-state value.
_Avoid_: Field, control, input, widget, atom (when meaning the primitive)

**Field Group**:
A named object of fields — Field Primitives or nested groups. A Slice's non-repeatable group is `primary`; reusable groups (e.g. the button) are defined once and shared across Slices.
_Avoid_: Props, fields blob

**List**:
A repeatable, bounded sequence of a single group or primitive. A Slice's `items` is a List (e.g. a List of buttons, capped by a max).
_Avoid_: Array, collection, repeater (loosely)

**Primitive Walk**:
A recursive descent over a Field Primitive tree — through Field Groups (`config.fields`) and Lists (`config.item`) down to the leaves. Two shapes: a **value walk** (`walkValue`) traverses a descriptor alongside a stored value and visits each leaf (real list indices in the path); a **def walk** (`walkDef`) is structure-only and visits every node with a positional path and list-nesting depth. Both live in `convex/lib/slices/walk.ts` so the descent and its casts exist once. A transform that _rebuilds_ a value tree (sample synthesis, localization) is not a Primitive Walk.
_Avoid_: Traversal, visitor (loosely), recursion

**Primitive Config**:
The typed, code-first parameters a field declaration passes to a Field Primitive to constrain what it allows (e.g. which formatting a rich-text field permits). Fixed by the schema author, never editable by the content editor.
_Avoid_: Options, settings (when meaning the field-author config)

**Profile**:
A named, finite Primitive Config preset for rich-text that fixes the allowed marks and nodes (`inline`, `basic`, `full`). A subtitle uses `inline`; a post body uses `full`. The Profile is enforced on write, not just hidden in the toolbar.
_Avoid_: Format set, toolbar config, level


## Module language

**Module**:
A contained piece of logic and UI that adds capabilities to formulacms; Core Modules are always on, and when an Optional Module is off its capabilities are absent. Contained means the module owns its capabilities and connects to the rest of formulacms only through declared interfaces, so turning it off removes just those capabilities (the admin offers none of its actions and the server refuses them) while the core keeps working and the module's data stays. _Example (future, not implemented)_: a Roles and Permissions module.
_Avoid_: plugin, extension, add-on.

**Core Module**:
An always-on module that makes up the core CMS: System, Owner access, Content model, Content editor, Publication, Media, Language or Email. It cannot be turned off and works without Optional Modules. Listed in Modules under "Core (always on)".
_Avoid_: system module, required module (code term only).

**Optional Module**:
A module that adds capabilities to the core. It starts off on new sites; the owner switches it in Modules, subject to safety checks, and configures it in Settings. When off, the admin sends no requests to use it and the server blocks that use.
_Avoid_: "off means deleted", "on means ready".

## Interface language

Owner decision (2026-11-07): "drop linl label and button label just label. link go soewhere .buttton do action."

**Link**:
An element that goes somewhere: it has a destination (a page, a URL, or `#` while no destination is set) and is rendered as `<a href>`. A link keeps this name even when it is styled to look like a button, for example a call to action in a featured menu block.
_Avoid_: Button, button link (for anything that has a destination)

**Button**:
An element that performs an action in place and has no destination: it opens a panel, switches language, saves or deletes. It is rendered as `<button>`.
_Avoid_: Link (for anything without a destination)

**Label**:
The visible text of a Link or a Button. The editing field is named "Label" for both; never "Link label" or "Button label".
_Avoid_: Link label, Button label, link text, caption
