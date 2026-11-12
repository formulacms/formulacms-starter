# formulacms

The canonical product language for formulacms. Editors compose Pages from locale-specific content and typed Slices.

> For the product's identity (name, label, positioning), see [`Identity.md`](Identity.md). This file describes the _content-authoring_ domain; its terms are defined in [GLOSSARY.md](GLOSSARY.md).

Term definitions live in [GLOSSARY.md](GLOSSARY.md) (owner rule 2026-11-04).

## Content authoring language

Term definitions for this section live in [GLOSSARY.md](GLOSSARY.md#content-authoring-language).

## Example dialogue

> **Dev:** The hero has a subtitle — is that plain text?
> **Editor:** It is one line, but it can have a little emphasis.
> **Dev:** Then the subtitle is a `rich-text` primitive on the `inline` Profile: bold, italic, link, nothing else. It physically can't grow a heading.
> **Editor:** Publishing the English content won't publish the French content too, right?
> **Dev:** Right. English and French are separate Localized Contents; the Page gives them one identity, but each is published independently.
> **Editor:** If I edit the English hero afterward, does the public page change immediately?
> **Dev:** No. You edit its Working Draft and preview that draft. The public site keeps reading the existing Published Snapshot until you publish English again.
> **Editor:** What if I change a shared author or hierarchy field?
> **Dev:** That changes the Shared Draft and marks each published locale as out of date. Each locale keeps its existing Published Snapshot until you deliberately republish it.
> **Editor:** Can I send that preview URL to someone outside the CMS?
> **Dev:** Not in the baseline. A Preview Session is tied to your signed-in identity and permission to read that Page's English Working Draft.
> **Editor:** I scheduled English for Monday, then edited its Working Draft. Which copy goes live?
> **Dev:** The immutable candidate you scheduled. Reschedule if the newer draft should replace it; a stale scheduled job cannot publish or withdraw a different snapshot.
> **Editor:** If I restore yesterday's English revision, does the public site roll back too?
> **Dev:** No. Restore copies that history into the English Working Draft without creating another revision. Publish it explicitly if it should become a new Published Snapshot.
> **Editor:** Will saving that restored draft change search results or navigation?
> **Dev:** No. Those read the English Public Projection and change only when publication state changes.
> **Editor:** And the picture?
> **Dev:** An `image` primitive — that's just the asset, alt, and a focal point. Its layout belongs to the hero renderer, not the image value.
> **Editor:** What about the "show on homepage" switch?
> **Dev:** A `boolean` primitive. It renders nothing itself — the Slice reads it to decide whether to show. And it's strictly on or off; there's no "unset".
