import { spawn } from "node:child_process"
import { StringDecoder } from "node:string_decoder"

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_LINE_BYTES = 4 * 1024 * 1024
const MAX_PENDING_REQUESTS = 256
const CLOSE_WAIT_MS = 1_000

function isRequestId(value) {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  )
}

function requestKey(id) {
  return `${typeof id}:${id}`
}

function localError(message, code) {
  const error = new Error(message)
  error.name = "CodexClientError"
  if (code !== undefined) error.code = code
  return error
}

function startupAbortedError() {
  const error = localError("Codex app-server startup was aborted.", "ABORT_ERR")
  error.name = "AbortError"
  return error
}

function serialize(message) {
  try {
    const line = JSON.stringify(message)
    if (line === undefined) throw new TypeError("undefined JSON value")
    return `${line}\n`
  } catch {
    throw localError("Codex app-server message must be JSON-serializable.")
  }
}

function killProcessGroup(child) {
  const { pid } = child
  if (pid === undefined) return

  try {
    if (process.platform === "win32") process.kill(pid, "SIGKILL")
    else process.kill(-pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // The owned process has already exited.
    }
  }
}

export class CodexClient {
  static async connect({
    command = "codex",
    cwd,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    args,
    signal,
  } = {}) {
    if (typeof command !== "string" || command.length === 0) {
      throw new TypeError("command must be a non-empty string")
    }
    if (
      !Number.isFinite(requestTimeoutMs) ||
      requestTimeoutMs <= 0 ||
      !Number.isSafeInteger(requestTimeoutMs)
    ) {
      throw new TypeError("requestTimeoutMs must be a positive integer")
    }
    if (
      args !== undefined &&
      (!Array.isArray(args) || args.some((value) => typeof value !== "string"))
    ) {
      throw new TypeError("args must be an array of strings")
    }
    if (
      signal !== undefined &&
      (signal === null ||
        typeof signal.aborted !== "boolean" ||
        typeof signal.addEventListener !== "function" ||
        typeof signal.removeEventListener !== "function")
    ) {
      throw new TypeError("signal must be an AbortSignal")
    }
    if (signal?.aborted) throw startupAbortedError()

    let child
    try {
      child = spawn(command, args ?? ["app-server", "--listen", "stdio://"], {
        cwd,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch {
      throw localError("Failed to start the Codex app-server process.")
    }

    const client = new CodexClient(child, requestTimeoutMs)
    let aborted = false
    const abortStartup = () => {
      aborted = true
      void client.close()
    }
    signal?.addEventListener("abort", abortStartup, { once: true })
    if (signal?.aborted) abortStartup()
    try {
      if (aborted) throw startupAbortedError()
      await client.request("initialize", {
        clientInfo: { name: "handoff-plus-runner", version: "1" },
        capabilities: { experimentalApi: true },
      })
      if (aborted) throw startupAbortedError()
      await client.#writeLine(
        serialize({ jsonrpc: "2.0", method: "initialized" })
      )
      if (aborted) throw startupAbortedError()
      return client
    } catch (error) {
      await client.close()
      if (aborted) throw startupAbortedError()
      throw error
    } finally {
      signal?.removeEventListener("abort", abortStartup)
    }
  }

  #child
  #requestTimeoutMs
  #nextId = 1
  #pending = new Map()
  #subscribers = new Set()
  #decoder = new StringDecoder("utf8")
  #lineBuffer = ""
  #lineBufferBytes = 0
  #fatalError
  #failureNotification
  #closing = false
  #processClosed = false
  #killStarted = false
  #closePromise
  #resolveProcessClosed
  #processClosedPromise

  constructor(child, requestTimeoutMs) {
    this.#child = child
    this.#requestTimeoutMs = requestTimeoutMs
    this.#processClosedPromise = new Promise((resolve) => {
      this.#resolveProcessClosed = resolve
    })

    child.stdout.on("data", (chunk) => this.#receive(chunk))
    child.stdout.once("end", () => this.#receiveEnd())

    // Never retain or print stderr. Draining it prevents a full pipe from
    // deadlocking the app-server and avoids exposing credentials or raw data.
    child.stderr.resume()

    child.once("error", (error) => {
      const code = error && typeof error === "object" ? error.code : undefined
      this.#fail(
        localError(
          code === "ENOENT"
            ? "The Codex executable was not found."
            : "The Codex app-server process failed to start.",
          code
        )
      )
    })
    child.once("close", () => {
      this.#processClosed = true
      this.#resolveProcessClosed()
      if (!this.#closing && !this.#fatalError) {
        this.#fail(
          localError("The Codex app-server process exited unexpectedly.")
        )
      }
    })
  }

  request(method, params, { timeoutMs = this.#requestTimeoutMs } = {}) {
    try {
      this.#assertMethod(method)
      this.#assertOpen()
      if (
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0 ||
        !Number.isSafeInteger(timeoutMs)
      ) {
        throw new TypeError("timeoutMs must be a positive integer")
      }
      if (this.#pending.size >= MAX_PENDING_REQUESTS) {
        throw localError("Codex app-server pending request limit reached.")
      }

      const id = this.#nextId
      if (!Number.isSafeInteger(id)) {
        throw localError("Codex app-server request id space exhausted.")
      }
      this.#nextId += 1
      const line = serialize({ jsonrpc: "2.0", id, method, params })

      return new Promise((resolve, reject) => {
        const key = requestKey(id)
        const timer = setTimeout(() => {
          if (!this.#pending.has(key)) return
          this.#fail(localError("Codex app-server request timed out."))
        }, timeoutMs)
        timer.unref?.()
        this.#pending.set(key, { id, method, resolve, reject, timer })

        this.#writeLine(line).catch((error) => this.#fail(error))
      })
    } catch (error) {
      return Promise.reject(error)
    }
  }

  notify(method, params) {
    this.#assertMethod(method)
    this.#assertOpen()
    const line = serialize({ jsonrpc: "2.0", method, params })
    this.#writeLine(line).catch((error) => this.#fail(error))
  }

  subscribe(callback) {
    if (typeof callback !== "function") {
      throw new TypeError("callback must be a function")
    }
    this.#subscribers.add(callback)
    if (this.#failureNotification) {
      queueMicrotask(() => {
        if (this.#subscribers.has(callback)) {
          this.#callSubscriber(callback, this.#failureNotification)
        }
      })
    }
    return () => this.#subscribers.delete(callback)
  }

  async close() {
    if (this.#closePromise) return this.#closePromise
    this.#closePromise = (async () => {
      this.#closing = true
      this.#rejectPending(localError("Codex app-server client closed."))
      this.#kill()
      try {
        this.#child.stdin.end()
      } catch {
        // The pipe may already be closed after a process failure.
      }

      if (!this.#processClosed) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, CLOSE_WAIT_MS)
          timer.unref?.()
          this.#processClosedPromise.then(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
      this.#subscribers.clear()
    })()
    return this.#closePromise
  }

  #assertMethod(method) {
    if (typeof method !== "string" || method.length === 0) {
      throw new TypeError("method must be a non-empty string")
    }
  }

  #assertOpen() {
    if (this.#fatalError) throw this.#fatalError
    if (this.#closing) throw localError("Codex app-server client is closed.")
  }

  #writeLine(line) {
    if (this.#fatalError) return Promise.reject(this.#fatalError)
    if (this.#closing) {
      return Promise.reject(localError("Codex app-server client is closed."))
    }
    return this.#writeRaw(line)
  }

  #writeRaw(line) {
    return new Promise((resolve, reject) => {
      try {
        this.#child.stdin.write(line, (error) => {
          if (error) {
            reject(
              localError("Failed to write to the Codex app-server process.")
            )
          } else {
            resolve()
          }
        })
      } catch {
        reject(localError("Failed to write to the Codex app-server process."))
      }
    })
  }

  #receive(chunk) {
    if (this.#fatalError || this.#closing) return
    this.#consumeDecoded(this.#decoder.write(chunk))
  }

  #receiveEnd() {
    if (this.#fatalError || this.#closing) return
    this.#consumeDecoded(this.#decoder.end())
    if (this.#lineBufferBytes !== 0) {
      this.#fail(
        localError("Codex app-server sent an unterminated JSON message.")
      )
    }
  }

  #consumeDecoded(decoded) {
    const parts = decoded.split("\n")
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]
      const complete = index < parts.length - 1
      const bytes = Buffer.byteLength(part)
      if (this.#lineBufferBytes + bytes > MAX_LINE_BYTES) {
        this.#fail(
          localError("Codex app-server JSON line exceeded the size limit.")
        )
        return
      }

      this.#lineBuffer += part
      this.#lineBufferBytes += bytes
      if (!complete) continue

      const line = this.#lineBuffer.endsWith("\r")
        ? this.#lineBuffer.slice(0, -1)
        : this.#lineBuffer
      this.#lineBuffer = ""
      this.#lineBufferBytes = 0
      if (line.trim() !== "") this.#parseLine(line)
      if (this.#fatalError) return
    }
  }

  #parseLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.#fail(localError("Codex app-server sent malformed JSON."))
      return
    }

    if (
      typeof message !== "object" ||
      message === null ||
      Array.isArray(message) ||
      (message.jsonrpc !== undefined && message.jsonrpc !== "2.0")
    ) {
      this.#fail(
        localError("Codex app-server sent an invalid JSON-RPC message.")
      )
      return
    }

    const hasId = Object.hasOwn(message, "id")
    const hasMethod = Object.hasOwn(message, "method")
    if (hasMethod) {
      if (typeof message.method !== "string" || message.method.length === 0) {
        this.#fail(
          localError("Codex app-server sent an invalid JSON-RPC method.")
        )
        return
      }
      if (hasId) {
        if (!isRequestId(message.id)) {
          this.#fail(localError("Codex app-server sent an invalid request id."))
          return
        }
        this.#rejectServerRequest(message.id)
      } else {
        this.#emit({ method: message.method, params: message.params })
      }
      return
    }

    if (!hasId || !isRequestId(message.id)) {
      this.#fail(
        localError("Codex app-server sent an invalid JSON-RPC response.")
      )
      return
    }
    const hasResult = Object.hasOwn(message, "result")
    const hasError = Object.hasOwn(message, "error")
    if (hasResult === hasError) {
      this.#fail(
        localError("Codex app-server sent an invalid JSON-RPC response.")
      )
      return
    }

    const key = requestKey(message.id)
    const pending = this.#pending.get(key)
    if (!pending) {
      this.#fail(
        localError("Codex app-server sent a response with an unknown id.")
      )
      return
    }
    this.#pending.delete(key)
    clearTimeout(pending.timer)

    if (hasResult) {
      pending.resolve(message.result)
      return
    }
    if (
      typeof message.error !== "object" ||
      message.error === null ||
      !Number.isSafeInteger(message.error.code) ||
      typeof message.error.message !== "string"
    ) {
      pending.reject(
        localError("Codex app-server returned an invalid error response.")
      )
      this.#fail(localError("Codex app-server sent an invalid JSON-RPC error."))
      return
    }
    pending.reject(
      localError(
        `Codex app-server request failed with JSON-RPC error ${message.error.code}.`,
        message.error.code
      )
    )
  }

  #rejectServerRequest(id) {
    const error = localError(
      "Codex app-server attempted an unsupported server-initiated request."
    )
    const line = serialize({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: "Server-initiated requests are not supported by this runner.",
      },
    })
    const write = this.#writeRaw(line)
    this.#fail(error, false)
    write.then(
      () => this.#killSoon(),
      () => this.#killSoon()
    )
  }

  #emit(notification) {
    for (const callback of [...this.#subscribers]) {
      this.#callSubscriber(callback, notification)
    }
  }

  #callSubscriber(callback, notification) {
    try {
      callback(notification)
    } catch {
      // A consumer callback cannot corrupt the transport or other subscribers.
    }
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  #fail(error, kill = true) {
    if (this.#fatalError || this.#closing) return
    this.#fatalError = error
    this.#failureNotification = {
      method: "runner/error",
      params: { message: error.message },
    }
    this.#rejectPending(error)
    this.#emit(this.#failureNotification)
    if (kill) this.#kill()
  }

  #kill() {
    if (this.#killStarted) return
    this.#killStarted = true
    killProcessGroup(this.#child)
  }

  #killSoon() {
    const timer = setTimeout(() => this.#kill(), 20)
    timer.unref?.()
  }
}
