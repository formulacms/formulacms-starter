import { spawnSync } from "node:child_process"

const preflightReport = ".cms-starter/preflight-report.json"
const appCreationReport = ".cms-starter/app-creation-report.json"
const feedbackReport = ".cms-starter/feedback-report.json"

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(command, args, {
    env,
    stdio: "inherit",
  })
}

const reportEnv = {
  ...process.env,
  STARTER_PREFLIGHT_REPORT: preflightReport,
  STARTER_APP_QA_REPORT: appCreationReport,
  STARTER_FEEDBACK_REPORT: feedbackReport,
}

const checks = run("pnpm", ["check:app-creation"], reportEnv)
const feedback = run("pnpm", ["check:app-creation:feedback"], reportEnv)

if (feedback.error) {
  console.error(feedback.error.message)
  process.exit(1)
}

if (feedback.status && feedback.status !== 0) {
  process.exit(feedback.status)
}

if (checks.error) {
  console.error(checks.error.message)
  process.exit(1)
}

process.exit(checks.status ?? 0)
