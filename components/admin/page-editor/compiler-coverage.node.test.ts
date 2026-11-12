import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { describe, expect, test } from "vitest"

/**
 * React Compiler 1.0.0 silently skips a whole component when it holds an
 * unsupported statement (`finally`, a `throw` inside `try`, value blocks inside
 * try/catch, a ref read in a default parameter, ...). ESLint passes on such
 * code while the build leaves the component uncompiled and un-memoized
 * (react/react#37789). This runs the same plugin the build uses (Next's own
 * bundled Babel, `reactCompiler: true`) and fails when one of the editor's hot
 * components is skipped. Seam test only: it proves our code stays compilable,
 * it does not test the compiler.
 */
const require = createRequire(import.meta.url)
const babel = require("next/dist/compiled/babel/core") as {
  transformSync(code: string, options: Record<string, unknown>): unknown
}
const syntaxTypescript = require("next/dist/compiled/babel/plugin-syntax-typescript")
const compiler = require("babel-plugin-react-compiler")

const root = path.resolve(__dirname, "../../..")

type LoggedEvent = {
  kind: string
  fnName?: string | null
  detail?: { reason?: string; options?: { reason?: string } }
}

function compileReport(file: string) {
  const events: LoggedEvent[] = []
  const filename = path.join(root, file)
  babel.transformSync(readFileSync(filename, "utf8"), {
    filename,
    babelrc: false,
    configFile: false,
    plugins: [
      [syntaxTypescript, { isTSX: true }],
      [
        compiler,
        {
          panicThreshold: "none",
          logger: {
            logEvent: (_: string, event: LoggedEvent) => events.push(event),
          },
        },
      ],
    ],
  })
  const compiled = events
    .filter((event) => event.kind === "CompileSuccess")
    .map((event) => event.fnName)
  const skipped = events
    .filter(
      (event) =>
        event.kind === "CompileError" ||
        event.kind === "CompileSkip" ||
        event.kind === "PipelineError"
    )
    .map(
      (event) =>
        event.detail?.reason ?? event.detail?.options?.reason ?? event.kind
    )
  return { compiled, skipped }
}

const mustCompile = [
  ["components/admin/page-editor.tsx", "PageEditorSession"],
  ["components/admin/page-editor/hooks/use-page-save.ts", "usePageSave"],
  ["components/admin/slice-builder.tsx", "SliceBuilder"],
  ["components/admin/live-preview-frame.tsx", "BoundLivePreviewFrame"],
  ["components/admin/page-live-preview-canvas.tsx", "AdminSlicePreviewZone"],
] as const

describe("the editor's hot components stay compiled by the React Compiler", () => {
  test.each(mustCompile)("%s compiles %s", (file, component) => {
    const { compiled, skipped } = compileReport(file)
    expect(
      compiled,
      `${component} was skipped by the React Compiler: ${skipped.join("; ")}`
    ).toContain(component)
  })
})


test("ED3 preview row Map uses the existing lazy-ref initialization pattern", () => {
  const source = readFileSync(path.join(process.cwd(), "components/admin/page-live-preview-canvas.tsx"), "utf8")
  expect(source).toMatch(/const sliceRefs = useRef<Map<string, HTMLDivElement> \| null>\(null\)/)
  expect(source).toMatch(/if \(sliceRefs.current === null\) \{\s*sliceRefs.current = new Map\(\)/)
})
