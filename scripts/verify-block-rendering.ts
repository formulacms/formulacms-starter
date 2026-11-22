import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright"
import {
  INSTALLED_BLOCK_TYPES,
  type InstalledBlockType,
} from "@/convex/lib/blocks"
import { loadBlockSimBaseUrl } from "./lib/block-sim-base"
import { waitForBlockSimReady } from "./lib/block-sim-readiness"
import { describeTextFields, sampleTextPaths } from "./lib/block-text-fields"

type AxeViolation = {
  id: string
  impact?: string
  help: string
  nodes: { target: string[] }[]
}

type ViewportName = keyof typeof VIEWPORTS

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)
const baseUrl = loadBlockSimBaseUrl()

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const

const failures: string[] = []
/** Fields the click check skipped, with the reason; not failures. */
const notes: string[] = []
/** Fields the check could not click; not failures, but never silent. */
const warnings: string[] = []


/** The first line of a thrown error, for a failure line. */
function reason(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).split(
    "\n"
  )[0]!
}

function findAxeBundle() {
  const direct = path.join(repoRoot, "node_modules", "axe-core", "axe.min.js")
  if (existsSync(direct)) return direct

  const pnpmRoot = path.join(repoRoot, "node_modules", ".pnpm")
  if (existsSync(pnpmRoot)) {
    for (const entry of readdirSync(pnpmRoot)) {
      if (!entry.startsWith("axe-core@")) continue
      const candidate = path.join(
        pnpmRoot,
        entry,
        "node_modules",
        "axe-core",
        "axe.min.js"
      )
      if (existsSync(candidate)) return candidate
    }
  }

  throw new Error("Could not find axe-core. Run `pnpm install` and try again.")
}

function routeFor(type: string) {
  return `/block-sim/${type}?bare=1`
}

async function waitForImages(page: Page) {
  await page
    .waitForFunction(
      () =>
        Array.from(document.images).every(
          (img) => img.complete && img.naturalWidth > 0
        ),
      { timeout: 8_000 }
    )
    .catch(() => undefined)
}

async function checkA11y(page: Page, axePath: string, label: string) {
  await page.addScriptTag({ path: axePath })
  const violations = (await page.evaluate(async () => {
    const axe = (
      window as typeof window & {
        axe: {
          run: (
            context: Document,
            options: Record<string, unknown>
          ) => Promise<{ violations: AxeViolation[] }>
        }
      }
    ).axe
    const results = await axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
      resultTypes: ["violations"],
    })
    return results.violations
  })) as AxeViolation[]

  for (const violation of violations) {
    const targets = violation.nodes
      .slice(0, 3)
      .map((node) => node.target.join(" "))
      .join("; ")
    failures.push(
      `${label}: axe ${violation.id} (${violation.impact ?? "unknown"}) ${violation.help}: ${targets}`
    )
  }
}

async function checkBlockSmoke(page: Page, label: string, hasText: boolean) {
  const result = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement
    const bodyText = document.body.textContent?.trim() ?? ""
    const controls = Array.from(
      document.querySelectorAll("input, textarea, select")
    )
    const unlabeledControls = controls
      .filter((control) => {
        const element = control as HTMLInputElement
        const type = element.getAttribute("type")?.toLowerCase()
        if (type === "hidden") return false
        if (element.getAttribute("aria-hidden") === "true") return false
        if (element.tabIndex < 0) return false
        if (element.getAttribute("aria-label")?.trim()) return false
        if (element.getAttribute("aria-labelledby")?.trim()) return false
        if (element.labels && element.labels.length > 0) return false
        return true
      })
      .map((control) => {
        const element = control as HTMLInputElement
        return element.name || element.id || element.outerHTML.slice(0, 80)
      })

    const unnamedActions = Array.from(
      document.querySelectorAll("button, a[href]")
    )
      .filter((action) => {
        const element = action as HTMLElement
        if (element.getAttribute("aria-hidden") === "true") return false
        if (element.tabIndex < 0) return false
        const label =
          element.getAttribute("aria-label") ||
          element.getAttribute("aria-labelledby") ||
          element.textContent
        return !label?.trim()
      })
      .map((action) => action.outerHTML.slice(0, 80))

    const brokenImages = Array.from(document.images).flatMap((image) => {
      const issues: string[] = []
      const src = image.getAttribute("src") ?? ""
      const currentSrc = image.currentSrc || src
      const descriptor = image.alt || src || image.outerHTML.slice(0, 80)
      const isSvg =
        /\.svg(?:$|[?#])/i.test(src) || /\.svg(?:$|[?#])/i.test(currentSrc)
      const isDataOrBlob = /^(data|blob):/i.test(currentSrc)

      if (!image.hasAttribute("alt")) {
        issues.push(`${descriptor}: missing alt attribute`)
      }
      if (image.complete && image.naturalWidth === 0) {
        issues.push(`${descriptor}: image failed to load`)
      }
      // No `data-nimg` test: the kit renders a plain <img> from Next's
      // getImageProps (no Image island), which Next does not stamp. The
      // optimizer address below is the proof of next/image.
      if (
        !isSvg &&
        !isDataOrBlob &&
        !currentSrc.includes("/_next/image") &&
        !src.includes("/_next/image")
      ) {
        issues.push(
          `${descriptor}: non-SVG image is not using Next image optimization`
        )
      }

      return issues
    })

    return {
      bodyTextLength: bodyText.length,
      fallbackVisible: bodyText.includes("Unstyled block:"),
      headingCount: document.querySelectorAll("h1, h2, h3").length,
      proseBlockCount: document.querySelectorAll("p, ul, ol, blockquote, table")
        .length,
      sectionCount: document.querySelectorAll("section").length,
      horizontalOverflow: Math.max(0, root.scrollWidth - root.clientWidth),
      unlabeledControls,
      unnamedActions,
      brokenImages,
      focusableCount: document.querySelectorAll(
        'a[href], button, input, textarea, select, details summary, [tabindex]:not([tabindex="-1"])'
      ).length,
    }
  })

  // A block with no text field (an image-only band) has no copy to measure.
  if (hasText && result.bodyTextLength < 20) {
    failures.push(`${label}: rendered body copy is unexpectedly sparse.`)
  }
  if (result.fallbackVisible) {
    failures.push(`${label}: rendered the unstyled block fallback.`)
  }
  if (hasText && result.headingCount < 1 && result.proseBlockCount < 1) {
    failures.push(`${label}: expected heading or prose content.`)
  }
  if (result.sectionCount < 1) {
    failures.push(`${label}: expected the block to render a section wrapper.`)
  }
  if (result.horizontalOverflow > 1) {
    failures.push(
      `${label}: page has ${result.horizontalOverflow}px horizontal overflow.`
    )
  }
  for (const control of result.unlabeledControls) {
    failures.push(`${label}: form control missing label: ${control}`)
  }
  for (const action of result.unnamedActions) {
    failures.push(`${label}: interactive element missing name: ${action}`)
  }
  for (const image of result.brokenImages) {
    failures.push(`${label}: ${image}`)
  }

  if (result.focusableCount > 0) {
    await page.keyboard.press("Tab")
    const focusResult = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null
      if (!active || active === document.body) {
        return { ok: false, detail: "focus remained on body" }
      }
      const styles = getComputedStyle(active)
      const hasFocusIndicator =
        styles.outlineStyle !== "none" ||
        styles.boxShadow !== "none" ||
        styles.textDecorationLine.includes("underline")
      return {
        ok: hasFocusIndicator,
        detail: `${active.tagName.toLowerCase()} ${active.getAttribute("aria-label") ?? active.textContent?.trim().slice(0, 40) ?? ""}`,
      }
    })
    if (!focusResult.ok) {
      failures.push(
        `${label}: first tabbable element lacks a visible focus style (${focusResult.detail}).`
      )
    }
  }
}

/**
 * The browser serializes a selection as it is shown, so a field styled with
 * `uppercase` reads "EYEBROW" where its text is "Eyebrow". Compare the
 * letters, not their case or spacing.
 */
function sameText(selected: string, expected: string) {
  const plain = (text: string) =>
    text.replace(/\s+/g, " ").trim().toLocaleLowerCase()
  return plain(selected) === plain(expected)
}

type ClickProbe = {
  x: number
  y: number
  before: string
  word: string
  paragraph: string
}
type MountSample = { height: number; width: number; next: number | null }

/**
 * The block factory's click guarantee, for every text field of the block in
 * the simulator: one click puts the caret on the clicked letter, a double
 * click selects the word, a triple click the paragraph under the pointer
 * (a title: the whole field). Opening the
 * editor never changes the field's box, never moves the content below it
 * and never scrolls. jsdom covers the click mapping; only a browser has the
 * real layout, double click and triple click.
 */
async function checkClickEditing(page: Page, label: string) {
  const paths = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-sim-field]"))
      .filter((host) => /\S/.test(host.textContent ?? ""))
      .map((host) => host.dataset.simField!)
  )
  if (!paths.length) failures.push(`${label}: no text field to click.`)
  const at = (path: string) => `[data-sim-field="${path}"]`
  const editorIn = (path: string) => `${at(path)} [data-preview-inline-editor]`

  const readProbe = (path: string) =>
    page.evaluate((selector): ClickProbe | null => {
      const host = document.querySelector<HTMLElement>(selector)!
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
      let node: Text | null = null
      for (let next = walker.nextNode(); next; next = walker.nextNode())
        if (/\S/.test((next as Text).data)) {
          node = next as Text
          break
        }
      if (!node) return null
      // The second letter of the field's first word, left quarter: the
      // caret lands before it.
      const index = node.data.search(/\S/) + 1
      const letter = document.createRange()
      letter.setStart(node, index)
      letter.setEnd(node, index + 1)
      const rect = letter.getBoundingClientRect()
      const before = document.createRange()
      before.setStart(host, 0)
      before.setEnd(node, index)
      const segments = [
        ...new Intl.Segmenter(undefined, { granularity: "word" }).segment(
          node.data
        ),
      ]
      const word = segments.find(
        (entry) =>
          entry.index <= index && index < entry.index + entry.segment.length
      )!.segment
      const block =
        node.parentElement!.closest("p,h1,h2,h3,h4,h5,h6,li") ?? host
      return {
        x: rect.left + rect.width / 4,
        y: rect.top + rect.height / 2,
        before: before.toString().replace(/\s+/g, " ").trimStart(),
        word,
        paragraph: (host.contains(block) ? block : host)
          .textContent!.replace(/\s+/g, " ")
          .trim(),
      }
    }, at(path))

  const open = async (path: string, probe: ClickProbe, clickCount: number) => {
    const where = `${label} ${path}`
    const start = await page.evaluate((selector) => {
      const host = document.querySelector<HTMLElement>(selector)!
      const after = Array.from(document.body.querySelectorAll("*")).find(
        (element) =>
          host.compareDocumentPosition(element) &
            Node.DOCUMENT_POSITION_FOLLOWING &&
          !host.contains(element) &&
          element.getBoundingClientRect().height > 0
      )
      const box = host.getBoundingClientRect()
      const samples: MountSample[] = []
      Object.assign(window, { __fcgSamples: samples })
      // One sample per frame until the editor has been up for three frames.
      // No named inner functions: tsx would wrap them in a helper the page
      // does not have.
      void (async () => {
        let ready = 0
        for (let frame = 0; frame < 300 && ready < 3; frame++) {
          await new Promise((resolve) => requestAnimationFrame(resolve))
          const now = host.getBoundingClientRect()
          samples.push({
            height: now.height,
            width: now.width,
            next: after ? after.getBoundingClientRect().top : null,
          })
          if (host.querySelector("[data-preview-inline-editor]")) ready++
        }
      })()
      return {
        height: box.height,
        width: box.width,
        next: after ? after.getBoundingClientRect().top : null,
        scrollY: window.scrollY,
      }
    }, at(path))
    // Paced like a person (about 80 ms apart), not back to back.
    await page.mouse.move(probe.x, probe.y)
    for (let click = 1; click <= clickCount; click++) {
      if (click > 1) await page.waitForTimeout(80)
      await page.mouse.down({ clickCount: click })
      await page.mouse.up({ clickCount: click })
    }
    await page
      .waitForSelector(editorIn(path), { timeout: 5_000 })
      .catch(() => {
        throw new Error(
          "the click did not open the field's editor within 5 seconds (does something cover the field, or is it outside its marker?)."
        )
      })
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        )
    )
    const end = await page.evaluate(() => ({
      samples: (window as unknown as { __fcgSamples: MountSample[] })
        .__fcgSamples,
      scrollY: window.scrollY,
      selection: window.getSelection()?.toString() ?? "",
    }))
    for (const sample of end.samples) {
      if (
        Math.abs(sample.height - start.height) > 1 ||
        Math.abs(sample.width - start.width) > 1
      )
        failures.push(
          `${where}: opening the editor changed the field box from ${start.width}x${start.height} to ${sample.width}x${sample.height}.`
        )
      if (
        start.next !== null &&
        sample.next !== null &&
        Math.abs(sample.next - start.next) > 1
      )
        failures.push(
          `${where}: opening the editor moved the content below by ${sample.next - start.next}px.`
        )
    }
    if (Math.abs(end.scrollY - start.scrollY) > 1)
      failures.push(
        `${where}: clicking a visible field scrolled the frame by ${end.scrollY - start.scrollY}px.`
      )
    return end.selection
  }

  const close = async (path: string) => {
    await page.keyboard.press("Escape")
    await page.waitForSelector(editorIn(path), {
      state: "detached",
      timeout: 5_000,
    })
  }

  const isShown = (path: string) =>
    page.evaluate((selector) => {
      const host = document.querySelector<HTMLElement>(selector)!
      const box = host.getBoundingClientRect()
      return (
        box.width > 0 &&
        box.height > 0 &&
        host.checkVisibility({
          visibilityProperty: true,
          opacityProperty: true,
        })
      )
    }, at(path))
  // A field inside a closed part of the block (a closed FAQ answer) is
  // opened first with the nearest closed disclosure control around it (an
  // accordion trigger), when the block has one.
  const openPart = (path: string) =>
    page.evaluate((selector) => {
      const host = document.querySelector<HTMLElement>(selector)!
      for (let node = host.parentElement; node; node = node.parentElement) {
        const control = Array.from(
          node.querySelectorAll<HTMLElement>('[aria-expanded="false"]')
        ).find((element) => !host.contains(element))
        if (!control) continue
        control.click()
        return true
      }
      return false
    }, at(path))

  // The guarantees hold for every field an owner can see and click. A field
  // check that fails is a failure line; the next field and block still run.
  for (const path of paths) {
    const where = `${label} ${path}`
    try {
      if (!(await isShown(path))) {
        if (await openPart(path)) await page.waitForTimeout(400)
        if (!(await isShown(path))) {
          notes.push(`${where}: hidden, not clickable.`)
          continue
        }
      }
      await checkField(path, where)
    } catch (error) {
      failures.push(`${where}: ${reason(error)}`)
      await page.keyboard.press("Escape").catch(() => {})
    }
  }

  async function checkField(path: string, where: string) {
    // A mostly visible field, so the frame has no reason to scroll.
    await page.evaluate((selector) => {
      document.querySelector(selector)!.scrollIntoView({ block: "center" })
    }, at(path))
    const probe = await readProbe(path)
    if (!probe) return

    // Each click count is its own check: one that fails or times out is a
    // failure line, and the next count still runs.
    const attempt = async (clicks: string, check: () => Promise<void>) => {
      try {
        await check()
      } catch (error) {
        failures.push(`${where} (${clicks}): ${reason(error)}`)
      }
      await close(path).catch((error: unknown) =>
        failures.push(`${where} (${clicks}): Escape: ${reason(error)}`)
      )
    }
    await attempt("one click", async () => {
      await open(path, probe, 1)
      const caret = await page.evaluate((selector) => {
        const selection = window.getSelection()
        const editor = document.querySelector(selector)
        if (!selection?.rangeCount || !editor || !selection.isCollapsed)
          return null
        const before = document.createRange()
        before.setStart(editor, 0)
        before.setEnd(selection.anchorNode!, selection.anchorOffset)
        return before.toString().replace(/\s+/g, " ").trimStart()
      }, editorIn(path))
      if (caret !== probe.before)
        failures.push(
          `${where}: one click put the caret after "${caret}", not after "${probe.before}".`
        )
    })
    await attempt("double click", async () => {
      const word = await open(path, probe, 2)
      if (!sameText(word, probe.word))
        failures.push(
          `${where}: a double click selected "${word}", not "${probe.word}".`
        )
    })
    await attempt("triple click", async () => {
      const field = await open(path, probe, 3)
      if (!sameText(field, probe.paragraph))
        failures.push(
          `${where}: a triple click selected "${field}", not "${probe.paragraph}".`
        )
    })
  }

  // A wrapped field whose first line only is on screen: opening it must
  // neither scroll the frame nor move the field.
  const wrapped = await page.evaluate(
    (selectors) => {
      for (const [path, selector] of selectors) {
        const host = document.querySelector<HTMLElement>(selector)!
        const line = parseFloat(getComputedStyle(host).lineHeight) || 24
        const box = host.getBoundingClientRect()
        if (box.height < line * 1.6) continue
        window.scrollTo(
          0,
          window.scrollY + box.top - (window.innerHeight - line * 1.5)
        )
        return path
      }
      return null
    },
    paths.map((path) => [path, at(path)] as const)
  )
  if (wrapped) {
    try {
      const probe = await readProbe(wrapped)
      if (probe) {
        await open(wrapped, probe, 1)
        await close(wrapped)
      }
    } catch (error) {
      failures.push(
        `${label} ${wrapped} (first line only on screen): ${reason(error)}`
      )
      await page.keyboard.press("Escape").catch(() => {})
    }
  }
}

async function checkBlock(
  context: BrowserContext,
  axePath: string,
  type: InstalledBlockType,
  viewport: ViewportName,
  hasText: boolean
) {
  const label = `${type} (${viewport} ${VIEWPORTS[viewport].width}x${VIEWPORTS[viewport].height})`
  const page = await context.newPage()
  page.on("console", (message) => {
    if (message.type() !== "error") return
    failures.push(`${label}: browser console error: ${message.text()}`)
  })
  page.on("pageerror", (error) => {
    failures.push(`${label}: page error: ${error.message}`)
  })

  try {
    const response = await page.goto(routeFor(type), {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    })
    await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {})
    await waitForImages(page)

    if (!response) {
      failures.push(`${label}: navigation produced no response.`)
    } else if (response.status() >= 400) {
      failures.push(`${label}: HTTP ${response.status()}.`)
    }

    await checkBlockSmoke(page, label, hasText)
    await checkA11y(page, axePath, label)
    // Last: it opens and closes editors.
    if (hasText) await checkClickEditing(page, label)
  } catch (error) {
    failures.push(`${label}: the check stopped: ${reason(error)}`)
  } finally {
    await page.close()
  }
}

async function createContext(browser: Browser, viewport: ViewportName) {
  return browser.newContext({
    baseURL: baseUrl,
    viewport: VIEWPORTS[viewport],
    deviceScaleFactor: viewport === "mobile" ? 2 : 1,
    colorScheme: "light",
  })
}

async function main() {
  // A cold dev server compiles the simulator on its first request, and it
  // answers 503 until the backend is up: wait for a real answer first.
  await waitForBlockSimReady({
    baseUrl,
    type: INSTALLED_BLOCK_TYPES[0]!,
    log: (message) => console.log(message),
  })
  const textPaths = new Map<InstalledBlockType, string[]>(
    INSTALLED_BLOCK_TYPES.map((type) => [type, sampleTextPaths(type)])
  )
  for (const [type, paths] of textPaths) {
    const { note, warning } = describeTextFields(type, paths)
    if (note) notes.push(note)
    if (warning) warnings.push(warning)
  }
  const axePath = findAxeBundle()
  const browser = await chromium.launch({ headless: true })

  try {
    for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
      const context = await createContext(browser, viewport)
      try {
        for (const type of INSTALLED_BLOCK_TYPES) {
          await checkBlock(
            context,
            axePath,
            type,
            viewport,
            textPaths.get(type)!.length > 0
          )
        }
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }

  for (const note of notes) console.log(`note: ${note}`)
  for (const warning of warnings) console.warn(`warning: ${warning}`)
  if (failures.length > 0) {
    console.error("Block rendering verification failed:")
    for (const failure of failures) {
      console.error(`- ${failure}`)
    }
    process.exit(1)
  }

  console.log(
    `✓ Block rendering, axe, image, focus, overflow and click-editing checks passed for ${INSTALLED_BLOCK_TYPES.length} installed block types at desktop 1440x900 and mobile 390x844.`
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
