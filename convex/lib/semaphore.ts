// Shared bounded-concurrency primitive for AI fan-out. One ceiling governs
// every agent's per-action fan-out (localizer translate, contentWriter
// rich-text refine) so tuning it is a single-site change.
export const MAX_CONCURRENT_LLM_CALLS = 6

/** Counting semaphore — bounds in-flight LLM calls per action invocation. */
export class Semaphore {
  private queue: (() => void)[] = []
  private active = 0
  constructor(private limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
  }
  release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) {
      this.active++
      next()
    }
  }
}
