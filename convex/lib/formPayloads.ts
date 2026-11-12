// Convex validators derived from the authored form schemas (ADR-0040).
//
// The ADR's "one schema, two validation gates" claim covers the client and
// server *gates*. Storage used to be a third, hand-written copy of the field
// list — a field added to the Zod schema would pass both gates and then be
// silently dropped at the insert. Deriving the storage validator here closes
// that seam: `lib/forms/*` is the only place fields are enumerated.
//
// This module is deliberately Convex-side. `lib/forms/contact.ts` stays pure
// Zod because the client form component imports it, and pulling
// `convex-helpers/server/*` into that graph would ship server code to the
// browser.
//
// Note: because storage now derives from the schema, adding a *required*
// field to `contactPayloadSchema` will fail the schema push against existing
// rows rather than dropping the field. That loud failure is this seam working
// as intended — widen with an optional field and backfill, don't revert it.

import { zodOutputToConvex } from "convex-helpers/server/zod4"
import { contactPayloadSchema } from "../../lib/forms/contact"

/**
 * Stored `formSubmissions.payload` shape for `form: "contact"`.
 *
 * Uses the *output* schema because what we persist is the post-transform
 * value (trimmed strings), not the raw submitted input.
 */
export const contactPayloadValidator = zodOutputToConvex(contactPayloadSchema)
