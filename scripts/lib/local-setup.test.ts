import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { validateNextRuntimeEnv } from "../../lib/env"
import {
  classifyDeployment,
  createConvexRunner,
  NEXT_START_KEYS,
  decideOwnerCode,
  isRealValue,
  ownerCodeBox,
  parseEnvText,
  planConvexSync,
  planLocalEnv,
  redact,
  runLocalSetup,
  skipReason,
  type ConvexRunResult,
  type ConvexRunner,
} from "./local-setup"

const ROOT = "/site"
const TEMPLATE = readFileSync(
  join(process.cwd(), ".env.local.example"),
  "utf8"
)
// What `convex dev` writes on the first start, before this step runs.
const CONVEX_LINES = [
  "# Deployment used by `npx convex dev`",
  "CONVEX_DEPLOYMENT=anonymous:anonymous-agent # team: anonymous, project: my-site",
  "",
  "NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210",
  "NEXT_PUBLIC_CONVEX_SITE_URL=http://127.0.0.1:3211",
  "",
].join("\n")
const SECRET_KEYS = [
  "BETTER_AUTH_SECRET",
  "CONTACT_IP_PROOF_SECRET",
  "REVALIDATE_SECRET",
] as const

function counter(prefix = "generated") {
  let count = 0
  return () => `${prefix}-${String(++count).padStart(2, "0")}-${"f".repeat(48)}`
}

type Call = { args: string[]; stdin: string; convexDeployment: string }

/** The quoting `convex env list` uses (CLI 1.49 formatEnvValueForDotfile) for one-line values. */
function dotfile(value: string): string {
  const quoted = /^["'].*["']$/.test(value) || value.includes("#")
  if (!quoted) return value
  return value.includes("'") && !value.includes('"') ? `"${value}"` : `'${value}'`
}

/** A fake Convex backend: an env store, an owner flag and a call log. */
function fakeConvex(options: {
  values?: Record<string, string>
  established?: boolean | "error"
  /** Fail the call whose first words are these, e.g. "env set REVALIDATE_SECRET". */
  fail?: string
  /** Throw from the call whose first words are these. */
  throwOn?: string
} = {}) {
  const store = new Map(Object.entries(options.values ?? {}))
  const calls: Call[] = []
  const runner: ConvexRunner = async (args, { stdin, convexDeployment }) => {
    calls.push({ args, stdin, convexDeployment })
    const words = args.slice(0, 3).join(" ")
    const matches = (prefix?: string) => prefix !== undefined && words.startsWith(prefix)
    if (matches(options.throwOn)) throw new Error(`boom ${[...store.values(), stdin].join(" ")}`)
    const failed = matches(options.fail)
    const ok = (stdout = ""): ConvexRunResult => ({ code: 0, stdout, stderr: "" })
    if (args[0] === "env" && args[1] === "list") {
      const stdout = [...store].map(([key, value]) => `${key}=${dotfile(value)}`).join("\n")
      if (failed) {
        return { code: 1, stdout, stderr: `✖ Cannot reach backend; known ${[...store.values()].join(" ")}` }
      }
      return ok(stdout)
    }
    if (args[0] === "env" && args[1] === "set") {
      if (failed) {
        return { code: 1, stdout: "", stderr: `✖ Failed to set ${args[2]} to ${stdin}` }
      }
      store.set(args[2], stdin)
      return { code: 0, stdout: "", stderr: `✔ Successfully set ${args[2]}` }
    }
    if (args[0] === "run") {
      if (failed || options.established === "error") return { code: 1, stdout: "", stderr: "✖ down" }
      return ok(JSON.stringify({ established: options.established ?? false }, null, 2))
    }
    throw new Error(`unexpected call ${args.join(" ")}`)
  }
  return { store, calls, runner }
}

function fakeFiles(initial: Record<string, string>) {
  const files = new Map(
    Object.entries(initial).map(([name, text]) => [join(ROOT, name), text])
  )
  const writes: string[] = []
  return {
    files,
    writes,
    readFile: (path: string) => files.get(path) ?? null,
    writeFile: (path: string, text: string) => {
      writes.push(path)
      files.set(path, text)
    },
    envLocal: () => files.get(join(ROOT, ".env.local")) ?? null,
  }
}

async function run(
  fs: ReturnType<typeof fakeFiles>,
  convex: ReturnType<typeof fakeConvex>,
  processEnv: Record<string, string | undefined> = {},
  generate = counter()
) {
  return runLocalSetup({
    projectRoot: ROOT,
    processEnv,
    runner: convex.runner,
    generate,
    readFile: fs.readFile,
    writeFile: fs.writeFile,
  })
}

const setCalls = (convex: ReturnType<typeof fakeConvex>) =>
  convex.calls.filter((call) => call.args[1] === "set").map((call) => call.args[2])

describe("parseEnvText and isRealValue", () => {
  test("reads KEY=value lines, quotes and Convex's inline comment", () => {
    const values = parseEnvText(
      [
        "# comment",
        "",
        "CONVEX_DEPLOYMENT=dev:happy-animal-123 # team: x, project: y",
        'QUOTED="a # b"',
        "SINGLE='c'",
        "export EXPORTED=1",
        "EMPTY=",
      ].join("\r\n")
    )
    expect(Object.fromEntries(values)).toEqual({
      CONVEX_DEPLOYMENT: "dev:happy-animal-123",
      QUOTED: "a # b",
      SINGLE: "c",
      EXPORTED: "1",
      EMPTY: "",
    })
  })

  test.each([
    ["A=abc#123", "A", "abc"],
    ['B="dev:x" # c', "B", "dev:x"],
    ["C=x #y", "C", "x"],
    ["D='a#b'", "D", "a#b"],
  ])("reads %s the way Node.js and dotenv do", (line, key, value) => {
    expect(parseEnvText(line).get(key)).toBe(value)
  })

  test.each([
    [undefined, false],
    ["", false],
    ["  ", false],
    ["replace-with-openssl-rand-hex-32", false],
    ["https://your-deployment.convex.cloud", false],
    ["sk-or-v1-your-key-here", false],
    ["https://example.com", false],
    ["0123456789abcdef", true],
    ["http://localhost:3000", true],
  ])("isRealValue(%j) is %s", (value, expected) => {
    expect(isRealValue(value)).toBe(expected)
  })
})

describe("classifyDeployment", () => {
  test.each([
    ["dev:happy-animal-123", "dev", "happy-animal-123"],
    ["dev:happy-animal-123 # team: x, project: y", "dev", "happy-animal-123"],
    ["anonymous:anonymous-agent", "anonymous", "anonymous-agent"],
    ["local:local-team-project", "local", "local"],
    ["local:local-my_team-my_project", "local", "local"],
  ])("accepts %s", (raw, kind, selector) => {
    expect(classifyDeployment(raw)).toMatchObject({ ok: true, kind, selector })
  })

  test.each([
    ["prod:happy-animal-123", "prod"],
    ["preview:my-branch", "preview"],
    ["staging:thing", "staging"],
    ["happy-animal-123", "unknown"],
    ["", null],
    [undefined, null],
  ])("refuses %j", (raw, kind) => {
    expect(classifyDeployment(raw)).toMatchObject({ ok: false, kind })
  })
})

describe("skipReason", () => {
  const ready = { processEnv: {}, envLocalText: CONVEX_LINES, envText: null }

  test("lets a development backend through", () => {
    expect(skipReason(ready)).toBeNull()
  })

  test.each([
    { label: "absent", value: undefined, off: false },
    { label: "empty", value: "", off: false },
    { label: "false", value: "false", off: true },
    { label: "0", value: "0", off: true },
    { label: "true", value: "true", off: true },
  ])("CI $label: setup off is $off", ({ value, off }) => {
    const result = skipReason({ ...ready, processEnv: { CI: value } })
    if (off) {
      expect(result).toBe(
        "[formulacms] Automatic local setup is off because CI is set. Set the secrets and the owner setup code yourself, as in docs/starter/local-setup.md."
      )
    } else expect(result).toBeNull()
  })

  test.each([
    "CONVEX_DEPLOY_KEY",
    "CONVEX_DEPLOYMENT_TOKEN",
    "CONVEX_SELF_HOSTED_URL",
    "CONVEX_SELF_HOSTED_ADMIN_KEY",
  ])("refuses %s in the shell, .env.local or .env", (key) => {
    const line = `[formulacms] Automatic local setup skipped: ${key} is set, so Convex could reach a hosted backend. Remove it from .env.local, .env and your shell, then run pnpm dev again.`
    expect(skipReason({ ...ready, processEnv: { [key]: "x" } })).toBe(line)
    expect(skipReason({ ...ready, envLocalText: `${CONVEX_LINES}${key}=x\n` })).toBe(line)
    expect(skipReason({ ...ready, envText: `${key}=x\n` })).toBe(line)
  })

  test.each([
    ["prod:happy-animal-123", "a production"],
    ["preview:my-branch", "a preview"],
    ["other:thing", "an unrecognized"],
  ])("refuses %s", (value, words) => {
    expect(
      skipReason({ ...ready, envLocalText: `CONVEX_DEPLOYMENT=${value}\n` })
    ).toBe(
      `[formulacms] Automatic local setup skipped: this folder uses ${words} Convex backend, and the automatic setup only sets up development backends. For a hosted site, follow docs/starter/hosting.md.`
    )
  })

  test("refuses a production value in the shell even when .env.local is a dev one", () => {
    expect(
      skipReason({ ...ready, processEnv: { CONVEX_DEPLOYMENT: "prod:happy-animal-123" } })
    ).toMatch(/a production Convex backend/)
  })

  test("asks for Convex's question when no backend is set", () => {
    expect(skipReason({ processEnv: {}, envLocalText: null, envText: null })).toBe(
      "[formulacms] Automatic local setup skipped: no Convex backend is set yet. Stop with Ctrl+C, run pnpm dev again and answer Convex's question."
    )
  })
})

describe("planLocalEnv", () => {
  const plan = (envLocalText: string | null, extra: Partial<Parameters<typeof planLocalEnv>[0]> = {}) =>
    planLocalEnv({
      envLocalText,
      templateText: TEMPLATE,
      processEnv: {},
      convexValues: new Map(),
      generate: counter(),
      ...extra,
    })

  test("starts from the template when .env.local is missing and replaces its placeholders in place", () => {
    const result = plan(null)
    expect(result.filled).toEqual(SECRET_KEYS)
    const lines = result.text!.split("\n")
    const templateLines = TEMPLATE.split("\n")
    expect(lines).toHaveLength(templateLines.length)
    expect(lines.filter((line, i) => line !== templateLines[i])).toEqual([
      expect.stringMatching(/^BETTER_AUTH_SECRET=generated-01-/),
      expect.stringMatching(/^REVALIDATE_SECRET=generated-03-/),
      expect.stringMatching(/^CONTACT_IP_PROOF_SECRET=generated-02-/),
    ])
  })

  test("appends the missing lines to Convex's own .env.local", () => {
    const result = plan(CONVEX_LINES)
    expect(result.filled).toEqual([...SECRET_KEYS, "BETTER_AUTH_URL"])
    expect(result.text!.startsWith(CONVEX_LINES)).toBe(true)
    expect(result.text!.endsWith("BETTER_AUTH_URL=http://localhost:3000\n")).toBe(true)
  })

  test("never overwrites a real value and keeps CRLF", () => {
    const text = "BETTER_AUTH_SECRET=keep-this-secret-value\r\nREVALIDATE_SECRET=replace-with-x\r\n"
    const result = plan(text)
    expect(result.effective.BETTER_AUTH_SECRET).toBe("keep-this-secret-value")
    expect(result.text).toBe(
      [
        "BETTER_AUTH_SECRET=keep-this-secret-value",
        `REVALIDATE_SECRET=${result.effective.REVALIDATE_SECRET}`,
        `CONTACT_IP_PROOF_SECRET=${result.effective.CONTACT_IP_PROOF_SECRET}`,
        "BETTER_AUTH_URL=http://localhost:3000",
        "",
      ].join("\r\n")
    )
  })

  test("the process environment wins and is never written", () => {
    const result = plan(CONVEX_LINES, {
      processEnv: { BETTER_AUTH_SECRET: "from-the-shell-123", BETTER_AUTH_URL: "http://localhost:3001" },
    })
    expect(result.effective.BETTER_AUTH_SECRET).toBe("from-the-shell-123")
    expect(result.effective.BETTER_AUTH_URL).toBe("http://localhost:3001")
    expect(result.filled).toEqual(["CONTACT_IP_PROOF_SECRET", "REVALIDATE_SECRET"])
    expect(result.text).not.toContain("from-the-shell-123")
    expect(result.text).not.toContain("BETTER_AUTH_URL")
  })

  test("copies a Convex value when the local one is missing", () => {
    const result = plan(CONVEX_LINES, {
      convexValues: new Map([["CONTACT_IP_PROOF_SECRET", "convex-has-this-one"]]),
    })
    expect(result.effective.CONTACT_IP_PROOF_SECRET).toBe("convex-has-this-one")
    expect(result.text).toContain("CONTACT_IP_PROOF_SECRET=convex-has-this-one\n")
  })

  test("returns null when nothing changes", () => {
    const complete = plan(CONVEX_LINES).text!
    expect(plan(complete).text).toBeNull()
  })
})

describe("planConvexSync", () => {
  const effective = {
    BETTER_AUTH_SECRET: "aaaaaaaaaa",
    CONTACT_IP_PROOF_SECRET: "bbbbbbbbbb",
    REVALIDATE_SECRET: "cccccccccc",
    BETTER_AUTH_URL: "http://localhost:3000",
  }

  test("sets only the missing or different keys", () => {
    const sync = planConvexSync({
      effective,
      convexValues: new Map([
        ["BETTER_AUTH_SECRET", "aaaaaaaaaa"],
        ["CONTACT_IP_PROOF_SECRET", "different"],
        ["BETTER_AUTH_URL", "http://localhost:3000"],
      ]),
    })
    expect(sync.set.map(({ key }) => key)).toEqual(["CONTACT_IP_PROOF_SECRET", "REVALIDATE_SECRET"])
    expect(sync.notes).toEqual([])
  })

  test("sets BETTER_AUTH_URL only when Convex has none", () => {
    const sync = planConvexSync({ effective, convexValues: new Map() })
    expect(sync.set).toContainEqual({ key: "BETTER_AUTH_URL", value: "http://localhost:3000" })
  })

  test("never changes an existing BETTER_AUTH_URL in Convex and says so", () => {
    const sync = planConvexSync({
      effective,
      convexValues: new Map([["BETTER_AUTH_URL", "http://localhost:3001"]]),
    })
    expect(sync.set.map(({ key }) => key)).not.toContain("BETTER_AUTH_URL")
    expect(sync.notes).toEqual([
      "[formulacms] BETTER_AUTH_URL in the Convex backend differs from .env.local. The automatic setup leaves it as it is; run pnpm check:preflight for details.",
    ])
  })

  test("leaves a non-local BETTER_AUTH_URL alone and says so", () => {
    const sync = planConvexSync({
      effective: { ...effective, BETTER_AUTH_URL: "https://mysite.org" },
      convexValues: new Map(),
    })
    expect(sync.set.map(({ key }) => key)).not.toContain("BETTER_AUTH_URL")
    expect(sync.notes).toEqual([
      "[formulacms] BETTER_AUTH_URL is not a localhost address, so the automatic setup did not copy it to Convex.",
    ])
  })
})

describe("decideOwnerCode", () => {
  const values = (entries: [string, string][]) => new Map(entries)

  test.each([
    [true, [["FORMULACMS_OWNER_CLAIM", "existing-code-1"]], { kind: "none" }],
    [null, [], { kind: "unknown" }],
    [false, [["FORMULACMS_OWNER_CLAIM", "existing-code-1"]], { kind: "show-existing", code: "existing-code-1" }],
    [false, [["NEXTCMS_OWNER_CLAIM", "legacy-code-12"]], { kind: "show-existing", code: "legacy-code-12" }],
    [false, [["FORMULACMS_OWNER_CLAIM", ""]], { kind: "create" }],
    [false, [], { kind: "create" }],
  ] as const)("established %s with %j", (ownerEstablished, entries, expected) => {
    expect(
      decideOwnerCode({ convexValues: values(entries as unknown as [string, string][]), ownerEstablished })
    ).toEqual(expected)
  })

  test("the box", () => {
    expect(ownerCodeBox("abc123", "http://localhost:3000")).toBe(
      [
        "[formulacms] ==================================================",
        "[formulacms] Owner setup code:",
        "[formulacms]",
        "[formulacms]     abc123",
        "[formulacms]",
        "[formulacms] Open http://localhost:3000/setup and paste this code",
        "[formulacms] when the setup asks for it. Until you finish setup,",
        "[formulacms] every pnpm dev shows it again.",
        "[formulacms] ==================================================",
      ].join("\n")
    )
  })
})

test("redact hides values of 8 characters or more", () => {
  expect(redact("a 12345678 b 1234 c 123456789", ["12345678", "1234", "123456789"])).toBe(
    "a [hidden] b 1234 c [hidden]"
  )
})

describe("runLocalSetup", () => {
  test("the owner's case: Convex lines only → fills, syncs, creates and shows the code", async () => {
    const fs = fakeFiles({ ".env.local": CONVEX_LINES })
    const convex = fakeConvex()
    const processEnv: Record<string, string | undefined> = {}
    const result = await run(fs, convex, processEnv)

    expect(result.status).toBe("ready")
    expect(result.wroteKeys).toEqual([...SECRET_KEYS, "BETTER_AUTH_URL"])
    const file = parseEnvText(fs.envLocal()!)
    for (const key of SECRET_KEYS) {
      expect(convex.store.get(key)).toBe(file.get(key))
      expect(processEnv[key]).toBe(file.get(key))
    }
    expect(convex.store.get("BETTER_AUTH_URL")).toBe("http://localhost:3000")
    expect(processEnv.BETTER_AUTH_URL).toBe("http://localhost:3000")
    const code = convex.store.get("FORMULACMS_OWNER_CLAIM")!
    expect(code).toMatch(/^generated-04-/)
    expect(result.box).toContain(`    ${code}`)
    expect(result.lines).toEqual([
      "[formulacms] Local setup: added BETTER_AUTH_SECRET, CONTACT_IP_PROOF_SECRET, REVALIDATE_SECRET, BETTER_AUTH_URL to .env.local.",
      "[formulacms] Local setup: set BETTER_AUTH_SECRET, CONTACT_IP_PROOF_SECRET, REVALIDATE_SECRET, BETTER_AUTH_URL, FORMULACMS_OWNER_CLAIM in the Convex backend.",
    ])
    expect(result.lines.join("\n")).not.toContain(code)
    expect(fs.envLocal()).not.toContain(code)
    // Every call names the deployment and pins CONVEX_DEPLOYMENT.
    for (const call of convex.calls) {
      expect(call.args.slice(-2)).toEqual(["--deployment", "anonymous-agent"])
      expect(call.convexDeployment).toBe("anonymous:anonymous-agent")
    }

    // Second start: nothing written, no env set, the same code shown again.
    const second = fakeConvex({ values: Object.fromEntries(convex.store) })
    const again = await run(fs, second, processEnv)
    expect(again.status).toBe("ready")
    expect(again.lines).toEqual([])
    expect(fs.writes).toHaveLength(1)
    expect(setCalls(second)).toEqual([])
    expect(again.box).toContain(`    ${code}`)
  })

  test("no .env.local: starts from the template", async () => {
    const fs = fakeFiles({ ".env.local.example": TEMPLATE })
    const convex = fakeConvex()
    const result = await run(fs, convex, { CONVEX_DEPLOYMENT: "dev:happy-animal-123" })
    expect(result.status).toBe("ready")
    expect(fs.envLocal()!.startsWith(TEMPLATE.split("BETTER_AUTH_SECRET=")[0])).toBe(true)
    expect(result.wroteKeys).toEqual(SECRET_KEYS)
    expect(convex.calls[0].args).toEqual(["env", "list", "--include-values", "--deployment", "happy-animal-123"])
  })

  test("placeholders in .env.local: replaced in place", async () => {
    const text = `${CONVEX_LINES}BETTER_AUTH_URL=http://localhost:3000\nBETTER_AUTH_SECRET=replace-with-openssl-rand-hex-32\nREVALIDATE_SECRET=\nCONTACT_IP_PROOF_SECRET=replace-with-x\n`
    const fs = fakeFiles({ ".env.local": text })
    // `convex dev` loaded the same placeholders into the process before this step.
    const processEnv: Record<string, string | undefined> = Object.fromEntries(parseEnvText(text))
    const result = await run(fs, fakeConvex(), processEnv)
    expect(result.wroteKeys).toEqual(SECRET_KEYS)
    expect(fs.envLocal()!.split("\n")).toHaveLength(text.split("\n").length)
    expect(fs.envLocal()).not.toContain("replace-with")
    const file = parseEnvText(fs.envLocal()!)
    for (const key of SECRET_KEYS) expect(processEnv[key]).toBe(file.get(key))
  })

  test("finished setup with an owner: silent, no write, no env set, no box", async () => {
    const complete = `${CONVEX_LINES}BETTER_AUTH_URL=http://localhost:3000\nBETTER_AUTH_SECRET=aaaaaaaaaaaa\nCONTACT_IP_PROOF_SECRET=bbbbbbbbbbbb\nREVALIDATE_SECRET=cccccccccccc\n`
    const fs = fakeFiles({ ".env.local": complete })
    const convex = fakeConvex({
      established: true,
      values: {
        BETTER_AUTH_URL: "http://localhost:3000",
        BETTER_AUTH_SECRET: "aaaaaaaaaaaa",
        CONTACT_IP_PROOF_SECRET: "bbbbbbbbbbbb",
        REVALIDATE_SECRET: "cccccccccccc",
        FORMULACMS_OWNER_CLAIM: "old-code-value",
      },
    })
    const result = await run(fs, convex)
    expect(result).toEqual({ status: "ready", lines: [], box: null, wroteKeys: [] })
    expect(fs.writes).toEqual([])
    expect(setCalls(convex)).toEqual([])
  })

  test("copies Convex's secret into .env.local instead of making a new one", async () => {
    const fs = fakeFiles({ ".env.local": CONVEX_LINES })
    const convex = fakeConvex({ values: { BETTER_AUTH_SECRET: "already-in-convex-1" } })
    await run(fs, convex)
    expect(parseEnvText(fs.envLocal()!).get("BETTER_AUTH_SECRET")).toBe("already-in-convex-1")
    expect(setCalls(convex)).not.toContain("BETTER_AUTH_SECRET")
  })

  test("secrets travel on stdin only, never as arguments", async () => {
    const fs = fakeFiles({ ".env.local": CONVEX_LINES })
    const convex = fakeConvex()
    await run(fs, convex)
    const secrets = [...convex.store.values()].filter((value) => value.startsWith("generated"))
    expect(secrets).toHaveLength(4)
    for (const call of convex.calls) {
      for (const secret of secrets) expect(call.args.join(" ")).not.toContain(secret)
    }
    for (const call of convex.calls.filter((call) => call.args[1] === "set")) {
      expect(call.stdin).toBe(convex.store.get(call.args[2]))
    }
  })

  test("shows an existing code, and the legacy key, while there is no owner", async () => {
    const fs = fakeFiles({ ".env.local": CONVEX_LINES })
    const legacy = fakeConvex({ values: { NEXTCMS_OWNER_CLAIM: "legacy-owner-code" } })
    const result = await run(fs, legacy)
    expect(result.box).toContain("    legacy-owner-code")
    expect(setCalls(legacy)).not.toContain("FORMULACMS_OWNER_CLAIM")
  })

  test("an owner exists: no code is set or shown", async () => {
    const fs = fakeFiles({ ".env.local": CONVEX_LINES })
    const convex = fakeConvex({ established: true })
    const result = await run(fs, convex)
    expect(result.box).toBeNull()
    expect(setCalls(convex)).not.toContain("FORMULACMS_OWNER_CLAIM")
  })

  test("the owner check fails: nothing set or shown, one plain line", async () => {
    const fs = fakeFiles({ ".env.local": CONVEX_LINES })
    const convex = fakeConvex({ established: "error" })
    const result = await run(fs, convex)
    expect(result.status).toBe("ready")
    expect(result.box).toBeNull()
    expect(setCalls(convex)).not.toContain("FORMULACMS_OWNER_CLAIM")
    expect(result.lines.at(-1)).toBe(
      "[formulacms] Could not check whether the site has an owner, so no owner setup code is shown. Run pnpm dev again."
    )
  })

  test("the box uses the BETTER_AUTH_URL origin", async () => {
    const fs = fakeFiles({ ".env.local": CONVEX_LINES })
    const result = await run(fs, fakeConvex(), { BETTER_AUTH_URL: "http://127.0.0.1:3005" })
    expect(result.box).toContain("Open http://127.0.0.1:3005/setup and paste this code")
  })

  test("env list output never reaches the lines", async () => {
    const fs = fakeFiles({ ".env.local": CONVEX_LINES })
    const convex = fakeConvex({ values: { RESEND_API_KEY: "re_secret_resend_key", BETTER_AUTH_SECRET: "convex-secret-value" } })
    const result = await run(fs, convex)
    const printed = [...result.lines, result.box ?? ""].join("\n")
    expect(printed).not.toContain("re_secret_resend_key")
    expect(printed).not.toContain("convex-secret-value")
  })

  describe("failure policy", () => {
    // Locally complete: Next.js can start (auth secret and both Convex URLs
    // are real). Locally incomplete: Convex has not written its URLs.
    const COMPLETE = `${CONVEX_LINES}BETTER_AUTH_URL=http://localhost:3000\nBETTER_AUTH_SECRET=local-secret-aaaa\nCONTACT_IP_PROOF_SECRET=local-secret-bbbb\nREVALIDATE_SECRET=local-secret-cccc\n`
    const INCOMPLETE = "CONVEX_DEPLOYMENT=anonymous:anonymous-agent\n"
    const cases = [
      { call: "env list", how: "fails", line: /^\[formulacms\] Automatic local setup could not read the Convex backend's settings, so it changed nothing: ✖ Cannot reach backend/ },
      { call: "env set BETTER_AUTH_SECRET", how: "fails", line: /^\[formulacms\] Automatic local setup could not set BETTER_AUTH_SECRET in the Convex backend: ✖ Failed to set BETTER_AUTH_SECRET to \[hidden\]$/ },
      { call: "env set CONTACT_IP_PROOF_SECRET", how: "fails", line: /could not set CONTACT_IP_PROOF_SECRET in the Convex backend: ✖ Failed to set CONTACT_IP_PROOF_SECRET to \[hidden\]$/ },
      { call: "env set REVALIDATE_SECRET", how: "fails", line: /could not set REVALIDATE_SECRET in the Convex backend: ✖ Failed to set REVALIDATE_SECRET to \[hidden\]$/ },
      { call: "env set BETTER_AUTH_URL", how: "fails", line: /could not set BETTER_AUTH_URL in the Convex backend: ✖ Failed to set BETTER_AUTH_URL to \[hidden\]$/ },
      { call: "env set FORMULACMS_OWNER_CLAIM", how: "fails", line: /could not set FORMULACMS_OWNER_CLAIM in the Convex backend: ✖ Failed to set FORMULACMS_OWNER_CLAIM to \[hidden\]$/ },
      { call: "env set CONTACT_IP_PROOF_SECRET", how: "throws", line: /^\[formulacms\] Automatic local setup failed: boom( \[hidden\])+$/ },
    ]
    const table = cases.flatMap((entry) => [
      { ...entry, local: "complete", text: COMPLETE, status: "ready" },
      { ...entry, local: "incomplete", text: INCOMPLETE, status: "failed" },
    ])

    test.each(table)(
      "$call $how, locally $local: $status, warning, no box",
      async ({ call, how, text, status, line }) => {
        const fs = fakeFiles({ ".env.local": text })
        const convex = fakeConvex({
          values: { RESEND_API_KEY: "re_secret_resend_key" },
          ...(how === "fails" ? { fail: call } : { throwOn: call }),
        })
        const result = await run(fs, convex)
        expect(result.status).toBe(status)
        expect(result.box).toBeNull()
        const failure = result.lines.at(-2)!
        expect(failure).toMatch(line)
        expect(result.lines.at(-1)).toBe(
          "[formulacms] Run pnpm dev again. If it keeps failing, run pnpm check:preflight."
        )
        const printed = result.lines.join("\n")
        expect(printed).not.toContain("re_secret_resend_key")
        expect(printed).not.toMatch(/generated-|local-secret-/)
        if (call === "env list") expect(fs.writes).toEqual([])
      }
    )

    test.each([
      ["complete", COMPLETE],
      ["incomplete", INCOMPLETE],
    ])("the owner query fails, locally %s: ready, one plain line, no box", async (_label, text) => {
      const fs = fakeFiles({ ".env.local": text })
      const convex = fakeConvex({ fail: "run cms/owner:getOwnerEstablished" })
      const result = await run(fs, convex)
      expect(result.status).toBe("ready")
      expect(result.box).toBeNull()
      expect(setCalls(convex)).not.toContain("FORMULACMS_OWNER_CLAIM")
      expect(result.lines.at(-1)).toBe(
        "[formulacms] Could not check whether the site has an owner, so no owner setup code is shown. Run pnpm dev again."
      )
    })
  })

  // Typed over NEXT_START_KEYS, so a new key needs a placeholder here.
  const START_PLACEHOLDERS: Record<(typeof NEXT_START_KEYS)[number], string> = {
    BETTER_AUTH_SECRET: "replace-with-openssl-rand-hex-32",
    NEXT_PUBLIC_CONVEX_URL: "https://your-deployment.convex.cloud",
    NEXT_PUBLIC_CONVEX_SITE_URL: "https://your-deployment.convex.site",
  }
  test.each(NEXT_START_KEYS.map((key) => ({ key, placeholder: START_PLACEHOLDERS[key] })))(
    "a placeholder $key in the process is replaced from .env.local before env list fails, so Next.js can start",
    async ({ key, placeholder }) => {
      const fs = fakeFiles({ ".env.local": `${CONVEX_LINES}BETTER_AUTH_SECRET=local-secret-aaaa\n` })
      const processEnv: Record<string, string | undefined> = { [key]: placeholder }
      const result = await run(fs, fakeConvex({ fail: "env list" }), processEnv)
      expect(result.status).toBe("ready")
      expect(processEnv[key]).toBe(parseEnvText(fs.envLocal()!).get(key))
      expect(() => validateNextRuntimeEnv(processEnv)).not.toThrow()
    }
  )

  describe("values quoted by convex env list", () => {
    test.each([
      ["a hex value", "0123456789abcdef0123456789abcdef"],
      ["a value with #", "abc#123456789"],
      ["a value printed in double quotes", "it's#secret-12"],
    ])("%s: Convex → .env.local → parse gives the Convex value", async (_label, value) => {
      const fs = fakeFiles({ ".env.local": CONVEX_LINES })
      const convex = fakeConvex({ values: { BETTER_AUTH_SECRET: value } })
      const processEnv: Record<string, string | undefined> = {}
      const result = await run(fs, convex, processEnv)
      expect(parseEnvText(fs.envLocal()!).get("BETTER_AUTH_SECRET")).toBe(value)
      expect(processEnv.BETTER_AUTH_SECRET).toBe(value)
      expect(setCalls(convex)).not.toContain("BETTER_AUTH_SECRET")
      expect(result.wroteKeys).toContain("BETTER_AUTH_SECRET")
    })

    test("an owner code with # is shown without the CLI's quotes", async () => {
      const fs = fakeFiles({ ".env.local": CONVEX_LINES })
      const result = await run(fs, fakeConvex({ values: { FORMULACMS_OWNER_CLAIM: "owner#code-123456" } }))
      expect(result.box).toContain("\n[formulacms]     owner#code-123456\n")
    })

    test("a value with no safe .env.local form is not copied; the person is told", async () => {
      const value = `it's"both-12345`
      const fs = fakeFiles({ ".env.local": CONVEX_LINES })
      const convex = fakeConvex({ values: { BETTER_AUTH_SECRET: value } })
      const processEnv: Record<string, string | undefined> = {}
      const result = await run(fs, convex, processEnv)
      expect(result.status).toBe("ready")
      expect(parseEnvText(fs.envLocal()!).has("BETTER_AUTH_SECRET")).toBe(false)
      expect(processEnv.BETTER_AUTH_SECRET).toBe(value)
      expect(setCalls(convex)).not.toContain("BETTER_AUTH_SECRET")
      expect(result.wroteKeys).not.toContain("BETTER_AUTH_SECRET")
      expect(result.lines).toContain(
        "[formulacms] Automatic local setup could not copy BETTER_AUTH_SECRET from the Convex backend into .env.local, because of the characters it holds. Add it to .env.local by hand, with the same value as in Convex."
      )
    })
  })

  describe("skips", () => {
    test.each([
      ["CI", { CI: "true" }, CONVEX_LINES],
      ["a deploy key", { CONVEX_DEPLOY_KEY: "prod:abc|key" }, CONVEX_LINES],
      ["a self-hosted URL", { CONVEX_SELF_HOSTED_URL: "https://convex.mysite.org" }, CONVEX_LINES],
      ["a production backend", {}, "CONVEX_DEPLOYMENT=prod:happy-animal-123\n"],
      ["no backend", {}, "# nothing yet\n"],
    ])("%s: no Convex call, no write; the line shows when something local is missing", async (_label, env, text) => {
      const fs = fakeFiles({ ".env.local": text })
      const convex = fakeConvex()
      const result = await run(fs, convex, { ...env })
      expect(result.status).toBe("skipped")
      expect(result.lines).toHaveLength(1)
      expect(result.lines[0]).toMatch(/^\[formulacms\] Automatic local setup (is off|skipped)/)
      expect(convex.calls).toEqual([])
      expect(fs.writes).toEqual([])
    })

    test("silent when the local values are all there", async () => {
      const fs = fakeFiles({
        ".env.local": "CONVEX_DEPLOYMENT=prod:happy-animal-123\nBETTER_AUTH_URL=https://mysite.org\nBETTER_AUTH_SECRET=aaaaaaaaaa\nCONTACT_IP_PROOF_SECRET=bbbbbbbbbb\nREVALIDATE_SECRET=cccccccccc\n",
      })
      const result = await run(fs, fakeConvex())
      expect(result).toEqual({ status: "skipped", lines: [], box: null, wroteKeys: [] })
    })
  })
})

test("the real runner: Node runs the package's bin, no shell, value on stdin, hosted keys removed", async () => {
  // A stand-in for the Convex CLI that echoes what it received.
  const root = mkdtempSync(join(tmpdir(), "local-setup-runner-"))
  try {
    const packageRoot = join(root, "node_modules", "convex")
    mkdirSync(join(packageRoot, "bin"), { recursive: true })
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ bin: { convex: "bin/main.js" } }))
    writeFileSync(
      join(packageRoot, "bin", "main.js"),
      `let input = ""
process.stdin.on("data", (chunk) => (input += chunk))
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    args: process.argv.slice(2),
    input,
    cwd: process.cwd(),
    deployment: process.env.CONVEX_DEPLOYMENT,
    deployKey: process.env.CONVEX_DEPLOY_KEY ?? null,
    selfHosted: process.env.CONVEX_SELF_HOSTED_URL ?? null,
  }))
  process.stderr.write("done")
  process.exitCode = 3
})`
    )
    const runner = createConvexRunner(root, {
      NODE_ENV: "test",
      PATH: process.env.PATH,
      CONVEX_DEPLOYMENT: "prod:other-thing-1",
      CONVEX_DEPLOY_KEY: "prod:key",
      CONVEX_SELF_HOSTED_URL: "https://convex.mysite.org",
    })
    const result = await runner(["env", "set", "KEY", "--deployment", "happy-animal-123"], {
      stdin: "secret-value",
      convexDeployment: "dev:happy-animal-123",
    })
    expect(result.code).toBe(3)
    expect(result.stderr).toBe("done")
    expect(JSON.parse(result.stdout)).toEqual({
      args: ["env", "set", "KEY", "--deployment", "happy-animal-123"],
      input: "secret-value",
      cwd: expect.stringContaining("local-setup-runner-"),
      deployment: "dev:happy-animal-123",
      deployKey: null,
      selfHosted: null,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
