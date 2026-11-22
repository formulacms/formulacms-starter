/**
 * The structural content-type checks (ADR-0059 amendment (8)): manifest,
 * starter selection, registration, admin messages, descriptors and the
 * definition check. The source repository also runs the renderer contract
 * (`scripts/verify-content-type-source.ts`).
 *
 *   pnpm content-type:verify -- [type]
 */
import { runContentTypeVerifyCli } from "../lib/content-types/authoring/verify"

process.exit(await runContentTypeVerifyCli(process.argv.slice(2)))
