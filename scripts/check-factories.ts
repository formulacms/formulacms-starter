/**
 * The factory gate (ADR-0059, amendment 2026-11-21 (6)). Read-only: it runs
 * every factory check, reports every failure with its repair and exits 1 on
 * any failure. The starter `pnpm build` runs it before `next build`, and
 * `pnpm check:preflight` runs the same checks.
 *
 *   pnpm check:factories
 */
import { factoryChecksReport, runFactoryChecks } from "../lib/factories/gate"

const { passed, text } = factoryChecksReport(await runFactoryChecks())
if (passed) {
  console.log(text)
} else {
  console.error(text)
  process.exit(1)
}
