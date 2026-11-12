import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import {
  buildFeedbackReport,
  writeFeedbackReport,
  type StarterFeedbackReport,
} from "./summarize-starter-feedback"

function tempPath(name: string) {
  return join(mkdtempSync(join(tmpdir(), "starter-feedback-")), name)
}

describe("starter feedback summary", () => {
  it("turns report failures and warnings into actionable feedback items", () => {
    const preflightPath = tempPath("preflight.json")
    const appCreationPath = tempPath("app-creation.json")
    writeFileSync(
      preflightPath,
      JSON.stringify({
        name: "starter-preflight",
        status: "failed",
        checks: [
          { name: "Node.js", status: "passed", message: "Node.js 22 ok." },
          {
            name: "REVALIDATE_SECRET",
            status: "warning",
            message: "REVALIDATE_SECRET is not set.",
          },
          {
            name: "BETTER_AUTH_SECRET",
            status: "failed",
            message: "BETTER_AUTH_SECRET=sk-test-secret-value leaked.",
          },
        ],
      })
    )
    writeFileSync(
      appCreationPath,
      JSON.stringify({
        name: "starter-app-creation",
        status: "failed",
        failures: ["desktop /: canonical path /fr does not match /."],
      })
    )

    const report = buildFeedbackReport({
      preflightPath,
      appCreationPath,
      generatedAt: new Date("2026-06-30T00:00:00.000Z"),
    })

    expect(report.status).toBe("needs-action")
    expect(report.summary.blockers).toBe(2)
    expect(report.summary.warnings).toBe(1)
    expect(report.items.map((item) => item.owner)).toContain(
      "starter-maintainer"
    )
    expect(JSON.stringify(report)).not.toContain("sk-test-secret-value")
  })

  it("writes a ready artifact when both reports pass cleanly", () => {
    const preflightPath = tempPath("preflight.json")
    const appCreationPath = tempPath("app-creation.json")
    const outputPath = tempPath("feedback.json")
    writeFileSync(
      preflightPath,
      JSON.stringify({
        name: "starter-preflight",
        status: "passed",
        checks: [
          { name: "Node.js", status: "passed", message: "Node.js 22 ok." },
        ],
      })
    )
    writeFileSync(
      appCreationPath,
      JSON.stringify({
        name: "starter-app-creation",
        status: "passed",
        failures: [],
      })
    )

    writeFeedbackReport({ preflightPath, appCreationPath, outputPath })

    const report = JSON.parse(
      readFileSync(outputPath, "utf8")
    ) as StarterFeedbackReport
    expect(report.status).toBe("ready")
    expect(report.summary.openItems).toBe(0)
    expect(report.items[0]?.status).toBe("closed")
  })
})
