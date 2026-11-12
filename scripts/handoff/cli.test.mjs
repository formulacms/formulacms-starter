import test from "node:test"
import assert from "node:assert/strict"
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  rm,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

const cli = fileURLToPath(new URL("./run.mjs", import.meta.url))
const fixture = new URL("./fixtures/runner-server.mjs", import.meta.url).href
async function run(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = "",
      stderr = ""
    child.stdout.on("data", (data) => {
      stdout += data
    })
    child.stderr.on("data", (data) => {
      stderr += data
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("Fixture runner hung."))
    }, 15000)
    child.on("error", reject)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

test(
  "CLI integrates persisted task advancement, independent commands, context steering, and restart",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-cli-"))
    try {
      const workspace = join(root, "workspace")
      const state = join(root, "state")
      await mkdir(workspace)
      await writeFile(
        join(workspace, "package.json"),
        JSON.stringify({ packageManager: "pnpm@11.20.0" })
      )
      const fake = join(root, "codex-fixture")
      await writeFile(
        fake,
        `#!/usr/bin/env node\nimport ${JSON.stringify(fixture)};\n`
      )
      await chmod(fake, 0o700)
      const plan = {
        version: 1,
        workspace,
        goal: "Create two fixture files",
        constraints: ["Local fixture only"],
        tasks: ["first", "second"].map((id) => ({
          id,
          instructions: `Create ${id}.txt`,
          acceptance: [`Exact text ${id} done with newline`],
          verify: [
            [
              process.execPath,
              "-e",
              `require('node:assert/strict').equal(require('node:fs').readFileSync('${id}.txt','utf8'),'${id} done\\n')`,
            ],
          ],
        })),
      }
      const planFile = join(root, "plan.json")
      await writeFile(planFile, JSON.stringify(plan))
      const checked = await run(["--plan", planFile, "--check"], workspace)
      assert.equal(checked.code, 0, checked.stderr)
      assert.deepEqual(JSON.parse(checked.stdout).executionContext, {
        model: "inherit",
        effort: "inherit",
        packageManager: "pnpm@11.20.0",
      })
      const result = await run(
        ["--plan", planFile, "--state", state, "--codex", fake],
        workspace
      )
      assert.equal(result.code, 0, result.stderr + result.stdout)
      const saved = JSON.parse(
        await readFile(join(state, "state.json"), "utf8")
      )
      assert.equal(saved.status, "complete")
      assert.deepEqual(
        saved.completed.map((t) => t.id),
        ["first", "second"]
      )
      const protocol = (
        await readFile(join(workspace, "protocol.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map(JSON.parse)
      const starts = protocol.filter((m) => m.method === "thread/start")
      assert.equal(starts.length, 3)
      assert.ok(
        starts.every(
          (m) =>
            m.params.sandbox === "workspace-write" &&
            m.params.approvalPolicy === "never"
        )
      )
      assert.equal(
        protocol.some((m) => m.method === "model/list"),
        false
      )
      assert.ok(
        starts.every(
          (m) =>
            !Object.hasOwn(m.params, "model") &&
            !Object.hasOwn(m.params, "effort")
        )
      )
      const turnStarts = protocol.filter((m) => m.method === "turn/start")
      assert.ok(
        turnStarts.every(
          (m) =>
            !Object.hasOwn(m.params, "model") &&
            !Object.hasOwn(m.params, "effort") &&
            m.params.input[0].text.includes('\"declared\": \"pnpm@11.20.0\"')
        )
      )
      assert.equal(
        protocol.filter((m) => m.method === "command/exec").length,
        2
      )
      assert.equal(protocol.filter((m) => m.method === "turn/steer").length, 1)
      const handoff = await readFile(saved.handoff, "utf8")
      assert.match(handoff, /Keep the exact newline/)
      assert.match(handoff, /Recursive context-window rule/)
      assert.match(handoff, /Model: inherited from active Codex context/)
      assert.match(handoff, /Package manager: pnpm@11\.20\.0/)
      const before = protocol.length
      const resumed = await run(
        ["--plan", planFile, "--state", state, "--codex", fake, "--resume"],
        workspace
      )
      assert.equal(resumed.code, 0, resumed.stderr)
      assert.equal(
        (await readFile(join(workspace, "protocol.jsonl"), "utf8"))
          .trim()
          .split("\n").length,
        before
      )
      saved.completed[0].checks[0].command = ["node", "-e", "process.exit(0)"]
      await writeFile(join(state, "state.json"), JSON.stringify(saved))
      const corrupted = await run(
        ["--plan", planFile, "--state", state, "--codex", fake, "--resume"],
        workspace
      )
      assert.equal(corrupted.code, 1)
      assert.match(corrupted.stderr, /inconsistent with the plan/)
      assert.equal(
        (await readFile(join(workspace, "protocol.jsonl"), "utf8"))
          .trim()
          .split("\n").length,
        before
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
