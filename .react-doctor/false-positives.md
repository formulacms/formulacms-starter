# React Doctor false positives

## React Compiler accepted baseline — `react-hooks-js/todo`

React Doctor 0.9.6 reports seven `todo` diagnostics because React Compiler 1.0
cannot lower `try` statements with `finally` clauses (and one without a catch)
inside event handlers. The handlers use `finally` to clear saving/pending state
after successful, failed, or cancelled mutations; removing it would introduce a
real stuck-control failure. Each exact occurrence has an inline suppression,
but the rule remains an error globally so any new occurrence fails CI.

- `components/admin/ai-settings-workbench.tsx:339`
- `components/admin/author-member-panel.tsx:34`
- `components/admin/slices/slice-card-actions.tsx:61,77`
- `components/admin/slices/slice-lifecycle-panel.tsx:123,145,177`

Re-evaluate this baseline when React Compiler gains `try`/`finally` lowering or
when any affected handler is refactored.

## no-derived-useState — AccountLanguagePicker

- **File:** `components/admin/settings/account-language-picker.tsx:26`
- **Rule:** `no-derived-useState`
- **Why this is a false positive:** `selected` is a pending-selection buffer that must diverge from `currentLocale` until the user clicks Apply. The call site passes `key={currentLocale}` (see `app/(core)/admin/(authenticated)/settings/account/page.tsx`), so React remounts the component whenever the locale changes, keeping the initial state correct. The prop-to-state copy is intentional here.

## server-auth-actions — public contact form

- **File:** `app/(public)/[locale]/_actions/contact.ts:29`
- **Rule:** `react-doctor/server-auth-actions`
- **Why this is a false positive:** `submitContactAction` is the public contact-form endpoint. It must accept anonymous visitors, and it delegates to the intentionally public `api.cms.contactSubmissions.submitContact` mutation, which enforces honeypot handling, validation, signed IP proof, and per-IP/global rate limits before persistence. The Server Action also rejects cross-origin submissions before calling Convex.

## nextjs-no-img-element — pixel-accurate editor surfaces

- **Files:** `app/(sim)/slice-sim/[type]/slice-workbench.tsx`, `components/admin/media-image-editor.tsx`, `components/admin/slices/fidelity-compare.tsx`
- **Rule:** `react-doctor/nextjs-no-img-element`
- **Why this is a false positive:** These are authenticated/dev authoring tools, not public content images. The snapshot comparison panes need native image sizing for fit/actual/zoom modes, and `ReactCrop` expects a real image element as its child so crop coordinates match the displayed media. Replacing these with `next/image` would change editor measurement behavior rather than improving visitor performance.

## active-static-asset — SVG media support

- **File:** `next.config.ts:16`
- **Rule:** `react-doctor/active-static-asset`
- **Why this is a false positive:** formulacms intentionally supports first-party SVG media for starter/logo/OG assets. `dangerouslyAllowSVG` is paired with `contentDispositionType: "attachment"` and a CSP of `default-src 'self'; script-src 'none'; sandbox;`, matching React Doctor's safe exception for SVG responses that are not executed inline.
