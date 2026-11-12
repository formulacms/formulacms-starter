import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { afterEach, test } from "node:test"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { CodexClient } from "./codex-client.mjs"

const fixture = fileURLToPath(
  new URL("./fixtures/codex-transport-server.mjs", import.meta.url)
)
const clients = new Set()
const temporaryDirectories = new Set()

async function connect(marker) {
  const client = await CodexClient.connect({
    command: process.execPath,
    args: marker ? [fixture, marker] : [fixture],
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    requestTimeoutMs: 500,
  })
  clients.add(client)
  return client
}

async function temporaryMarker(name) {
  const directory = await mkdtemp(join(tmpdir(), "codex-transport-test-"))
  temporaryDirectories.add(directory)
  return join(directory, name)
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await delay(5)
  }
}

afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close()))
  clients.clear()
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
  temporaryDirectories.clear()
})

test("handles split and coalesced frames, out-of-order replies, and notifications", async () => {
  const client = await connect()
  const notifications = []
  const unsubscribe = client.subscribe((notification) =>
    notifications.push(notification)
  )

  const first = client.request("test/out-of-order", { value: "first" })
  const second = client.request("test/out-of-order", { value: "second" })

  assert.equal(await second, "second")
  assert.equal(await first, "first")
  assert.deepEqual(notifications, [
    { method: "test/progress", params: { step: 1 } },
  ])
  assert.equal(unsubscribe(), true)
  await client.close()
  await client.close()
})

test("rejects server requests, reports runner/error, and sends a JSON-RPC error", async () => {
  const marker = await temporaryMarker("server-request.json")
  const client = await connect(marker)
  const notifications = []
  client.subscribe((notification) => notifications.push(notification))

  await assert.rejects(
    client.request("test/server-request", {}),
    /unsupported server-initiated request/
  )
  await waitFor(() => existsSync(marker))

  const response = JSON.parse(await readFile(marker, "utf8"))
  assert.equal(response.id, "server-request-1")
  assert.equal(response.error.code, -32601)
  assert.deepEqual(notifications, [
    {
      method: "runner/error",
      params: {
        message:
          "Codex app-server attempted an unsupported server-initiated request.",
      },
    },
  ])
})

test("a request timeout rejects pending work and kills the owned process group", async () => {
  const marker = await temporaryMarker("timeout-survivor")
  const client = await connect(marker)
  const notifications = []
  client.subscribe((notification) => notifications.push(notification))

  const hanging = client.request("test/timeout", {}, { timeoutMs: 40 })
  const alsoPending = client.request("test/out-of-order", { value: "pending" })
  await assert.rejects(hanging, /timed out/)
  await assert.rejects(alsoPending, /timed out/)
  await delay(400)

  if (process.platform !== "win32") assert.equal(existsSync(marker), false)
  assert.equal(notifications.at(-1)?.method, "runner/error")
  await client.close()
})

test("unexpected process exit rejects pending work and cleans up descendants", async () => {
  const marker = await temporaryMarker("exit-survivor")
  const client = await connect(marker)
  const notifications = []
  client.subscribe((notification) => notifications.push(notification))

  await assert.rejects(client.request("test/exit", {}), /exited unexpectedly/)
  await delay(400)

  if (process.platform !== "win32") assert.equal(existsSync(marker), false)
  assert.equal(notifications.at(-1)?.method, "runner/error")
  await client.close()
})

test("malformed protocol input fails closed and is reported", async () => {
  const client = await connect()
  const notifications = []
  client.subscribe((notification) => notifications.push(notification))

  await assert.rejects(client.request("test/malformed", {}), /malformed JSON/)
  assert.equal(notifications.at(-1)?.method, "runner/error")
  await assert.rejects(
    client.request("test/after-failure", {}),
    /malformed JSON/
  )
})

test("caps concurrent pending calls", async () => {
  const client = await connect()
  const pending = Array.from({ length: 256 }, () =>
    client.request("test/never", {}, { timeoutMs: 5_000 })
  )

  await assert.rejects(
    client.request("test/never", {}, { timeoutMs: 5_000 }),
    /pending request limit/
  )
  const settled = Promise.allSettled(pending)
  await client.close()
  const outcomes = await settled
  assert.equal(
    outcomes.every(({ status }) => status === "rejected"),
    true
  )
})

test("aborting startup closes the process group and cannot return a live client", async () => {
  const processMarker = await temporaryMarker("startup-process")
  const survivorMarker = join(dirname(processMarker), "startup-survivor")
  const controller = new AbortController()
  const connecting = CodexClient.connect({
    command: process.execPath,
    args: [fixture, processMarker, "delay-initialize", survivorMarker],
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    requestTimeoutMs: 5_000,
    signal: controller.signal,
  })
  await waitFor(() => existsSync(processMarker))
  const pid = Number(await readFile(processMarker, "utf8"))

  const abortedAt = Date.now()
  controller.abort()
  await assert.rejects(
    connecting,
    (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR"
  )
  assert.ok(Date.now() - abortedAt < 1_500, "startup abort was not prompt")
  await waitFor(() => {
    try {
      process.kill(pid, 0)
      return false
    } catch (error) {
      return error.code === "ESRCH"
    }
  })
  await delay(400)
  if (process.platform !== "win32")
    assert.equal(existsSync(survivorMarker), false)
})
