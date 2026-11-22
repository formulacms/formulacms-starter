import { expect, test, type Frame, type Page } from "playwright/test"
import { localPath, ownerPage } from "../support"

/**
 * Page editor live preview: opening the Hero Agency title in place. Editing
 * in the preview is always on (owner, 2026-11-21): no on/off button, no
 * "only in the form" notice. Two variables, four combinations: the in-place
 * editor's code is cold (every script held back 800 ms from before the page
 * loads, so its preload is late) or warm (already loaded), and the page is
 * fresh (no block selected, page scrolled to the
 * top, no setup scrolling) or settled (the Hero already selected, the page
 * already scrolled). For every interaction, sampled on every animation frame
 * from pointer down until the editor is ready and the clicks are over:
 * (a) the title's height and text never drop, (b) the description's top
 * does not move, (c) nothing scrolls under the pointer: the preview frame's
 * place on screen, the page editor's scroller and the document stay put.
 * Then (d) a native double click, 60, 150 or 250 ms between its clicks,
 * selects the word under the pointer and (e) a triple click selects the
 * title's text. Two more starting points, code loaded: another block
 * already selected, and right after a click on a form-only field (its form
 * control took the focus; nothing may move the preview while the title's
 * clicks land). Last, a double and a triple click on a form-only
 * rich-text paragraph select the word and the paragraph in the form editor
 * while the preview stays put. The Hero's eyebrow, a one-line plain text
 * field, opens in place like the title (PR A3, owner 2026-11-21): the same
 * interactions, sampled on the eyebrow with the title below it.
 *
 * Preconditions: built English owner app; FR6_E2E_CLICK_PAGE_PATH names the
 * editor of a page whose first block is a Hero Agency with an eyebrow and a
 * title of at least two words each and a description, and whose second block is a Rich Text
 * Body with at least two paragraphs, with no recovered browser draft (it
 * blocks editing in the preview). The scenario edits nothing: Escape
 * closes each field unchanged. Server: as every non-disposable spec (see
 * `playwright.config.ts`).
 */

const TITLE =
  '[data-preview-block-occurrence] [data-preview-field="primary.title"]'
const DESCRIPTION =
  '[data-preview-block-occurrence] [data-preview-field="primary.description"]'
const EDITOR = `${TITLE} [data-preview-inline-editor]`
const EYEBROW =
  '[data-preview-block-occurrence] [data-preview-field="primary.eyebrow"]'

/** The field a scenario clicks, and the field below it that must not move. */
type FieldTarget = { host: string; below: string; editor: string }
const TITLE_FIELD: FieldTarget = {
  host: TITLE,
  below: DESCRIPTION,
  editor: EDITOR,
}
const EYEBROW_FIELD: FieldTarget = {
  host: EYEBROW,
  below: TITLE,
  editor: `${EYEBROW} [data-preview-inline-editor]`,
}
const BODY_PARAGRAPH =
  '[data-preview-block-occurrence] [data-preview-field="primary.body"] p'
const FORM_BODY = '[data-block-field-path="primary.body"]'

type Sample = { height: number; text: number; descriptionTop: number | null }
type Place = { frameTop: number; scroller: number; document: number }
type Code = "cold" | "warm"
type Context = "fresh" | "settled" | "other-selected" | "after-form-click"
type Interaction =
  | { name: string; clicks: 1 }
  | { name: string; clicks: 2; gap: number }
  | { name: string; clicks: 3; gap: number }

const INTERACTIONS: Interaction[] = [
  { name: "one click", clicks: 1 },
  { name: "double click, 60 ms apart", clicks: 2, gap: 60 },
  { name: "double click, 150 ms apart", clicks: 2, gap: 150 },
  { name: "double click, 250 ms apart", clicks: 2, gap: 250 },
  { name: "triple click", clicks: 3, gap: 120 },
]

function liveFrame(page: Page): Frame {
  const frame = page
    .frames()
    .find((entry) => /\/live-frame\//.test(entry.url()))
  if (!frame) throw new Error("The page editor shows no live preview")
  return frame
}

async function openEditor(page: Page) {
  await page.goto(localPath("FR6_E2E_CLICK_PAGE_PATH"))
  await expect
    .poll(() =>
      page.frames().some((entry) => /\/live-frame\//.test(entry.url()))
    )
    .toBe(true)
  const frame = liveFrame(page)
  await expect(frame.locator(TITLE).first()).toBeVisible()
  return frame
}

/** Page point of letter 1 of the title's second word, and that word. */
/**
 * Page point of letter 1 of the second word in match `nth` of `selector`,
 * that word, and the whole text of that match.
 */
async function textPoint(
  page: Page,
  frame: Frame,
  selector: string,
  nth: number
) {
  const inFrame = await frame.evaluate(
    ({ selector, nth }) => {
      const host = document.querySelectorAll(selector)[nth]!
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = (node as Text).data
        const match = /\S+\s+(\S)/.exec(text)
        if (!match) continue
        const index = match.index + match[0].length - 1
        const range = document.createRange()
        range.setStart(node, index + 1)
        range.setEnd(node, index + 2)
        const box = range.getBoundingClientRect()
        return {
          x: box.left + box.width / 4,
          y: box.top + box.height / 2,
          // The editor's word rule: letters and digits, an apostrophe inside.
          word: /^[\p{L}\p{M}\p{N}]+(?:['\u2019][\p{L}\p{M}\p{N}]+)*/u.exec(
            text.slice(index)
          )![0],
          title: host.textContent!.replace(/\s+/g, " ").trim(),
        }
      }
      throw new Error(`${selector} needs at least two words`)
    },
    { selector, nth }
  )
  const frameBox = await page.evaluate(() => {
    const element = Array.from(document.querySelectorAll("iframe")).find(
      (entry) => /\/live-frame\//.test(entry.src)
    )!
    const box = element.getBoundingClientRect()
    return { x: box.left, y: box.top, scale: box.width / element.clientWidth }
  })
  return {
    x: frameBox.x + inFrame.x * frameBox.scale,
    y: frameBox.y + inFrame.y * frameBox.scale,
    word: inFrame.word,
    title: inFrame.title,
  }
}

/**
 * Where the preview sits: the frame's top on screen, the page editor's
 * scroller (the one that holds the frame) and the document's scroll.
 */
function readPlace(): Place {
  const element = Array.from(document.querySelectorAll("iframe")).find(
    (entry) => /\/live-frame\//.test(entry.src)
  )!
  let scroller: Element | null = element.parentElement
  while (
    scroller &&
    !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
  )
    scroller = scroller.parentElement
  return {
    frameTop: element.getBoundingClientRect().top,
    scroller: scroller ? scroller.scrollTop : 0,
    document: document.documentElement.scrollTop,
  }
}

/** Waits until the preview has not moved for five frames in a row. */
async function waitUntilStill(page: Page) {
  let last = JSON.stringify(await page.evaluate(readPlace))
  for (let still = 0, round = 0; still < 5 && round < 600; round++) {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve))
    )
    const now = JSON.stringify(await page.evaluate(readPlace))
    still = now === last ? still + 1 : 0
    last = now
  }
}

async function startPlaceSampling(page: Page) {
  const start = await page.evaluate(readPlace)
  await page.evaluate(() => {
    const element = Array.from(document.querySelectorAll("iframe")).find(
      (entry) => /\/live-frame\//.test(entry.src)
    )!
    let scroller: Element | null = element.parentElement
    while (
      scroller &&
      !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
    )
      scroller = scroller.parentElement
    const samples: Place[] = []
    const state = { samples, stop: false }
    Object.assign(window, { __previewPlaceSamples: state })
    void (async () => {
      while (!state.stop && samples.length < 1200) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        samples.push({
          frameTop: element.getBoundingClientRect().top,
          scroller: scroller ? scroller.scrollTop : 0,
          document: document.documentElement.scrollTop,
        })
      }
    })()
  })
  return start
}

async function startSampling(frame: Frame, target: FieldTarget) {
  return frame.evaluate(
    ({ title, description }) => {
      const host = document.querySelector(title)!
      const below = document.querySelector(description)
      const samples: Sample[] = []
      const state = { samples, stop: false }
      Object.assign(window, { __previewClickSamples: state })
      // No named inner functions: the spec's compiler may wrap them in a
      // helper the page does not have.
      void (async () => {
        for (let frame = 0; frame < 1200 && !state.stop; frame++) {
          await new Promise((resolve) => requestAnimationFrame(resolve))
          samples.push({
            height: host.getBoundingClientRect().height,
            text: (host.textContent ?? "").replace(/\s+/g, " ").trim().length,
            descriptionTop: below ? below.getBoundingClientRect().top : null,
          })
        }
      })()
      return {
        height: host.getBoundingClientRect().height,
        text: (host.textContent ?? "").replace(/\s+/g, " ").trim().length,
        descriptionTop: below ? below.getBoundingClientRect().top : null,
      }
    },
    { title: target.host, description: target.below }
  )
}

/** How long after the last click the preview must still be in place. */
const SETTLE_MS = 450

/** Stops the place sampler and returns its samples. */
async function stopPlaceSampling(page: Page) {
  return page.evaluate(() => {
    const state = (
      window as unknown as {
        __previewPlaceSamples: { samples: Place[]; stop: boolean }
      }
    ).__previewPlaceSamples
    state.stop = true
    return state.samples
  })
}

/**
 * Asserts the preview stayed within 1 px of its start, and records the
 * frame position samples (min and max per value) in the test output.
 */
function expectStill(label: string, start: Place, places: Place[]) {
  const range = (key: keyof Place) => {
    const values = places.map((place) => Math.round(place[key] * 10) / 10)
    return [Math.min(...values), Math.max(...values)]
  }
  console.log(
    `PLACE ${label}: ${places.length} frames, start ${JSON.stringify(start)}, frameTop ${JSON.stringify(range("frameTop"))}, scroller ${JSON.stringify(range("scroller"))}, document ${JSON.stringify(range("document"))}`
  )
  const moved = (key: keyof Place) =>
    Math.max(0, ...places.map((place) => Math.abs(place[key] - start[key])))
  expect(
    moved("frameTop"),
    "preview frame moved on screen (px)"
  ).toBeLessThanOrEqual(1)
  expect(
    moved("scroller"),
    "page editor scroller moved (px)"
  ).toBeLessThanOrEqual(1)
  expect(moved("document"), "document scrolled (px)").toBeLessThanOrEqual(1)
}

async function interact(
  page: Page,
  frame: Frame,
  interaction: Interaction,
  label: string,
  settleMs = SETTLE_MS,
  target: FieldTarget = TITLE_FIELD
) {
  // The click point is read only once nothing moves.
  await waitUntilStill(page)
  const point = await textPoint(page, frame, target.host, 0)
  const placeStart = await startPlaceSampling(page)
  const start = await startSampling(frame, target)
  await page.mouse.move(point.x, point.y)
  let lastClick = Date.now()
  for (let click = 1; click <= interaction.clicks; click++) {
    if (click > 1 && "gap" in interaction)
      await page.waitForTimeout(interaction.gap)
    lastClick = Date.now()
    await page.mouse.down({ clickCount: click })
    await page.mouse.up({ clickCount: click })
  }
  await frame.locator(target.editor).first().waitFor({ timeout: 10_000 })
  await page.waitForTimeout(Math.max(0, settleMs - (Date.now() - lastClick)))
  await frame.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )
  )
  const places = await stopPlaceSampling(page)
  const end = await frame.evaluate(() => {
    const state = (
      window as unknown as {
        __previewClickSamples: { samples: Sample[]; stop: boolean }
      }
    ).__previewClickSamples
    state.stop = true
    return {
      samples: state.samples,
      selection: (window.getSelection()?.toString() ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    }
  })
  // Position first: a move is the cause when the later clicks miss.
  expectStill(`${label}, ${interaction.name}`, placeStart, places)
  for (const sample of end.samples) {
    expect(
      Math.abs(sample.height - start.height),
      "clicked field height"
    ).toBeLessThanOrEqual(1)
    expect(sample.text, "clicked field text length").toBe(start.text)
    if (start.descriptionTop !== null && sample.descriptionTop !== null)
      expect(
        Math.abs(sample.descriptionTop - start.descriptionTop),
        "description top"
      ).toBeLessThanOrEqual(1)
  }
  // Chrome's selection text applies text-transform (an eyebrow is often
  // uppercase); the DOM text is the field's own casing.
  const selected = end.selection.toLowerCase()
  if (interaction.clicks === 1) expect(selected).toBe("")
  if (interaction.clicks === 2) expect(selected).toBe(point.word.toLowerCase())
  if (interaction.clicks === 3) expect(selected).toBe(point.title.toLowerCase())
  await page.keyboard.press("Escape")
  await expect(frame.locator(target.editor)).toHaveCount(0)
}

const HOLD_BACK = "**/_next/static/chunks/**"

/** Holds back every script the page asks for from here on. */
async function holdBackScripts(page: Page) {
  await page.route(HOLD_BACK, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800))
    await route.continue()
  })
}

/**
 * Selects the Hero with its block button and scrolls the page editor down
 * (the title stays on screen), then waits until nothing moves.
 */
async function settle(page: Page, frame: Frame) {
  await frame.locator("[data-preview-block-control]").first().click()
  await waitUntilStill(page)
  await page.evaluate(() => {
    const element = Array.from(document.querySelectorAll("iframe")).find(
      (entry) => /\/live-frame\//.test(entry.src)
    )!
    let scroller: HTMLElement | null = element.parentElement
    while (
      scroller &&
      !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
    )
      scroller = scroller.parentElement
    if (!scroller) return
    const behavior = scroller.style.scrollBehavior
    scroller.style.scrollBehavior = "auto"
    // Up to 120 px, never past the frame's top edge.
    scroller.scrollTop += Math.max(
      0,
      Math.min(120, element.getBoundingClientRect().top - 40)
    )
    scroller.style.scrollBehavior = behavior
  })
  await waitUntilStill(page)
}

/**
 * Brings match `nth` of `selector` on screen with an instant scroll of the
 * page editor's scroller (setup only), then waits until nothing moves.
 */
async function bringOnScreen(
  page: Page,
  frame: Frame,
  selector: string,
  nth: number
) {
  const top = await frame.evaluate(
    ({ selector, nth }) =>
      document.querySelectorAll(selector)[nth]!.getBoundingClientRect().top,
    { selector, nth }
  )
  await page.evaluate((inFrameTop) => {
    const element = Array.from(document.querySelectorAll("iframe")).find(
      (entry) => /\/live-frame\//.test(entry.src)
    )!
    const box = element.getBoundingClientRect()
    const top = box.top + inFrameTop * (box.width / element.clientWidth)
    if (top > 80 && top < window.innerHeight - 160) return
    let scroller: HTMLElement | null = element.parentElement
    while (
      scroller &&
      !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
    )
      scroller = scroller.parentElement
    if (!scroller) return
    const behavior = scroller.style.scrollBehavior
    scroller.style.scrollBehavior = "auto"
    scroller.scrollTop += top - window.innerHeight / 3
    scroller.style.scrollBehavior = behavior
  }, top)
  await waitUntilStill(page)
}

/** Opens a fresh page for one interaction in the named combination. */
async function prepare(page: Page, code: Code, context: Context) {
  // Cold: the frame preloads the editor's code as soon as it connects, so
  // the hold starts before the page loads.
  if (code === "cold") await holdBackScripts(page)
  const frame = await openEditor(page)
  await waitUntilStill(page)
  if (context === "settled") await settle(page, frame)
  if (context === "other-selected") {
    // The second block's button: today's selection scroll, then still.
    await frame.locator("[data-preview-block-control]").nth(1).click()
    await waitUntilStill(page)
    await bringOnScreen(page, frame, TITLE, 0)
  }
  // Warm: let the editor's code, preloaded once the frame connects,
  // arrive: no new resource for one second (at most ten).
  if (code === "warm")
    await frame.evaluate(async () => {
      // No named inner functions (see startSampling).
      let count = -1
      for (let still = 0, round = 0; still < 10 && round < 100; round++) {
        const now = performance.getEntriesByType("resource").length
        still = now === count ? still + 1 : 0
        count = now
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    })
  if (context === "after-form-click") {
    // One click on a form-only paragraph: its form control takes the focus
    // at once and comes into view once the click is over. No notice shows.
    await bringOnScreen(page, frame, BODY_PARAGRAPH, 0)
    const point = await textPoint(page, frame, BODY_PARAGRAPH, 0)
    await page.mouse.click(point.x, point.y)
    await expect
      .poll(() =>
        page.evaluate(
          (field) => Boolean(document.activeElement?.closest(field)),
          FORM_BODY
        )
      )
      .toBe(true)
    await waitUntilStill(page)
    await bringOnScreen(page, frame, TITLE, 0)
  }
  return frame
}

/**
 * A double or triple click on a form-only rich-text paragraph: the preview
 * stays put during the clicks, then the form editor holds the word or the
 * paragraph.
 */
async function formOnlyInteract(
  page: Page,
  frame: Frame,
  interaction: Interaction,
  label: string
) {
  await bringOnScreen(page, frame, BODY_PARAGRAPH, 1)
  const point = await textPoint(page, frame, BODY_PARAGRAPH, 1)
  const placeStart = await startPlaceSampling(page)
  await page.mouse.move(point.x, point.y)
  let lastClick = Date.now()
  for (let click = 1; click <= interaction.clicks; click++) {
    if (click > 1 && "gap" in interaction)
      await page.waitForTimeout(interaction.gap)
    lastClick = Date.now()
    await page.mouse.down({ clickCount: click })
    await page.mouse.up({ clickCount: click })
  }
  // Before the form scroll, which waits 500 ms.
  await page.waitForTimeout(Math.max(0, 400 - (Date.now() - lastClick)))
  expectStill(
    `${label}, ${interaction.name}`,
    placeStart,
    await stopPlaceSampling(page)
  )
  const selected = () =>
    page.evaluate((field) => {
      const active = document.activeElement
      if (!active?.closest(field)) return null
      return (document.getSelection()?.toString() ?? "")
        .replace(/\s+/g, " ")
        .trim()
    }, FORM_BODY)
  const expected =
    interaction.clicks === 2
      ? point.word
      : interaction.clicks === 3
        ? point.title
        : ""
  await expect.poll(selected, { timeout: 10_000 }).toBe(expected)
}

test.describe("page preview: opening the Hero title in place", () => {
  test.skip(
    !process.env.FR6_E2E_CLICK_PAGE_PATH,
    "Set FR6_E2E_CLICK_PAGE_PATH to an admin page whose first block is Hero Agency (no recovered browser draft) to run the click-timing check."
  )
  test.setTimeout(420_000)

  const combinations: [Code, Context, string][] = [
    ["cold", "fresh", "code cold, no block selected, page at the top"],
    ["cold", "settled", "code cold, the Hero selected, page scrolled"],
    ["warm", "fresh", "code loaded, no block selected, page at the top"],
    ["warm", "settled", "code loaded, the Hero selected, page scrolled"],
  ]
  for (const [code, context, title] of combinations)
    test(title, async ({ browser }) => {
      const page = await ownerPage(browser)
      try {
        for (const interaction of INTERACTIONS)
          await test.step(interaction.name, async () => {
            const frame = await prepare(page, code, context)
            try {
              await interact(page, frame, interaction, title)
            } finally {
              if (code === "cold") await page.unroute(HOLD_BACK)
            }
          })
      } finally {
        await page.context().close()
      }
    })

  const starts: [Context, string][] = [
    ["other-selected", "code loaded, another block selected"],
    ["after-form-click", "code loaded, right after a form-only click"],
  ]
  for (const [context, title] of starts)
    test(title, async ({ browser }) => {
      const page = await ownerPage(browser)
      try {
        for (const interaction of INTERACTIONS.slice(1))
          await test.step(interaction.name, async () => {
            const frame = await prepare(page, "warm", context)
            // No notice shows or hides now, so nothing may move up to the
            // usual settle time after the last click.
            await interact(page, frame, interaction, title)
          })
      } finally {
        await page.context().close()
      }
    })

  test("the eyebrow, a plain text field, opens in place like the title", async ({
    browser,
  }) => {
    const page = await ownerPage(browser)
    try {
      for (const interaction of INTERACTIONS)
        await test.step(interaction.name, async () => {
          const frame = await prepare(page, "warm", "fresh")
          await bringOnScreen(page, frame, EYEBROW, 0)
          await interact(
            page,
            frame,
            interaction,
            "eyebrow, code loaded",
            SETTLE_MS,
            EYEBROW_FIELD
          )
        })
    } finally {
      await page.context().close()
    }
  })

  test("a form-only rich-text paragraph: double and triple click", async ({
    browser,
  }) => {
    const page = await ownerPage(browser)
    try {
      for (const interaction of INTERACTIONS.slice(2, 3).concat(
        INTERACTIONS.slice(4)
      ))
        await test.step(interaction.name, async () => {
          const frame = await prepare(page, "warm", "fresh")
          await formOnlyInteract(
            page,
            frame,
            interaction,
            "form-only paragraph"
          )
        })
    } finally {
      await page.context().close()
    }
  })
})
