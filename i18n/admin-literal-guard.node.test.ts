import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  discoverR1ShippedFiles,
  isR1LiteralSource,
  scanR1Source,
} from "./admin-literal-ratchet"

const path = "components/admin/planted-guard-control.tsx"
const categories = (source: string) =>
  new Set(scanR1Source(source, path).map((finding) => finding.category))

describe("planted negative controls for reviewed residual classes", () => {
  test.each([
    "try { await save() } catch (err) { toast.error(err.message) }",
    "function displayFailure(failure){return failure.message} function UI({fault}){return <p>{displayFailure(fault)}</p>}",
    "function UI(){try{run()}catch(failure){const renamed=failure.message;setError(renamed)}}",
    "function UI({fault}){const renamed=fault.message;return <p>{renamed}</p>}",
    "function identity(value){return value} function UI({fault}){const detail=fault.message;return <p>{identity(detail)}</p>}",
    "const providerError = result.error; setError(providerError.message)",
    "function UI({fault}){return <p>{`${fault.message}`}</p>}",
    "catch(fault){toast.error(`Failure: ${fault.message}`)}",
    'function UI({fault}){const detail=fault.message;return <p>{t("failure",{detail})}</p>}',
    'catch (e) { form.setError("root", {message: e.message ?? t("failed")}) }',
    "function displayError(e) { return e.message } export function UI({error}) { return <p>{displayError(error)}</p> }",
    "function UI({error}) { const message = error.message; return <p>{message}</p> }",
    "function UI({error}) { return <p>{error.message}</p> }",
    "function UI(){ const [error,setError]=useState(null); async function save(){try{await run()}catch(e){setError({message:e.message})}} return <p>{error?.message}</p> }",
  ])("blocks raw caught/provider message flow %#", (source) => {
    expect(categories(source)).toContain("raw-error-message")
  })
  test.each([
    'function copy(){ return "Waiting for content" } function UI(){return <p>{copy()}</p>}',
    'function UI(){const label="New menu item";return <button>{label}</button>}',
    'const copy = () => "Try again"; function UI(){ return <p>{copy()}</p> }',
    'function identity(value){return value} function UI(){return <p>{identity("New default label")}</p>}',
    'function label(value="New default label"){return value} function UI(){return <p>{label()}</p>}',
    'function UI(){const importedTitle = title || "Imported page"; return <input title={importedTitle}/>}',
  ])("blocks helper/local UI prose %#", (source) => {
    expect(categories(source)).toContain("helper-return-label")
  })
  test.each(["label", "title", "description", "placeholder"])(
    "blocks object %s defaults",
    (name) => {
      expect(
        categories(`const item = {${name}: "New editable default"}`)
      ).toContain("object-default")
    }
  )
  test.each([
    "const label = new Date(savedAt).toLocaleString()",
    "const label = new Date(savedAt).toLocaleDateString()",
    "const label = new Date(savedAt).toLocaleTimeString()",
    "const label = bytes.toLocaleString()",
    "function formatBytes(bytes){return bytes.toFixed(1)} function UI({bytes}){return <p>{formatBytes(bytes)}</p>}",
    "function UI({value}){return <p>{value.toPrecision(2)}</p>}",
    "const label=new Intl.NumberFormat([]).format(bytes)",
    "const label = new Intl.NumberFormat().format(bytes)",
    "const label = new Intl.DateTimeFormat(undefined, opts).format(savedAt)",
  ])("blocks implicit locale formatting %#", (source) => {
    expect(categories(source)).toContain("implicit-locale-format")
  })
})

describe("positive controls retain source diagnostics and translated consumers", () => {
  test.each([
    'catch(error){console.error(error.message); throw new Error("Server-only diagnostic")}',
    'catch(error){if(error.message.includes("STATE_STALE")) retry(); toast.error(t("failed"))}',
    'function errorCode(error){return error.message} function UI(){const code=errorCode(error);return <p>{code === "STALE" ? t("stale") : t("failed")}</p>}',
    'function UI(){return <p>{t("message")}</p>}',
    'function UI(){return <div aria-live="polite">{t("message")}</div>}',
    'function UI(){toast.message(t("saved"));setError(t("failed"));form.setError("root",{message: t("failed")});return <p>{form.formState.errors.root?.message}</p>}',
    'const schema=z.string().min(1,t("required"));function UI(){const form=useForm({resolver:zodResolver(schema)});return <p>{form.formState.errors.title?.message}</p>}',
    'function UI(){toast.error(displayError(error,t("failed")));form.setError("root",{message:displayError(error,t("failed"))});return <p>{form.formState.errors.root?.message}</p>}',
    'const metadata={title: getMetadataCopy(locale,"adminTitle")}',
    'const item={label:t("newItem"), title:getContentDefault(locale,"importedPage"), description:undefined}',
    "const label = new Date(at).toLocaleString(locale);const count=new Intl.NumberFormat(locale).format(bytes)",
    "const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone",
    "console.debug(new Date().toLocaleString());console.info(new Intl.NumberFormat().format(42))",
    "const width=scale.toFixed(1);console.debug(width)",
    'function diagnostic(){return "Server-only diagnostic"} console.error(diagnostic())',
  ])("keeps safe translated/diagnostic control %#", (source) => {
    expect(scanR1Source(source, path)).toEqual([])
  })
  test("decodes JSX punctuation entities but still rejects encoded prose", () => {
    expect(scanR1Source("<p>&copy; &#169;</p>", path)).toEqual([])
    expect(categories("<p>&#69;nglish text</p>")).toContain("jsx-text")
  })
  test("translated class-boundary message prop is proven at every local caller", () => {
    expect(
      scanR1Source(
        'import {useTranslations} from "next-intl"; class Boundary {render(){return <p>{this.props.message}</p>}} function UI(){const t=useTranslations("ui");return <Boundary message={t("failure")}/>}',
        path
      )
    ).toEqual([])
    expect(
      categories(
        "class Boundary {render(){return <p>{this.props.message}</p>}} function UI({fault}){return <Boundary message={fault.message}/>}"
      )
    ).toContain("raw-error-message")
  })
  test("does not treat method toast.message as raw property data", () => {
    expect(categories('toast.message(t("message"))')).not.toContain(
      "raw-error-message"
    )
  })
})

describe("frozen shipped selector invariants", () => {
  test("accepts future public/shared source names and rejects tests/declarations", () => {
    for (const target of [
      "components/public/new-renderer.tsx",
      "components/content-types/new.ts",
      "components/slices/new.tsx",
      "app/(public)/new/page.tsx",
      "app/(live-preview)/admin/pages/[id]/live-frame/[locale]/page.tsx",
      "components/ui/dialog.tsx",
      "components/ui/sheet.tsx",
      "components/development-instance-badge.tsx",
    ])
      expect(isR1LiteralSource(target)).toBe(true)
    for (const target of [
      "components/public/new.test.tsx",
      "components/slices/new.d.ts",
      "components/public/new.sourceInventory.ts",
      "components/ui/button.tsx",
    ])
      expect(isR1LiteralSource(target)).toBe(false)
  })
  test("newly shipped targets fail the frozen inventory instead of disappearing", () => {
    const files = discoverR1ShippedFiles(process.cwd()).map(
      (file) => file.shippedPath
    )
    expect(() =>
      discoverR1ShippedFiles(
        process.cwd(),
        new Set([...files, "components/public/planted-new-target.tsx"])
      )
    ).toThrow("omits selected shipped path")
    expect(() =>
      discoverR1ShippedFiles(
        process.cwd(),
        new Set(files.filter((path) => path !== "components/public/footer.tsx"))
      )
    ).toThrow("non-shipped path")
  })
  test("uses actual overlay bytes and can discover a standalone app without release tooling", () => {
    const root = mkdtempSync(join(tmpdir(), "r1-standalone-guard-"))
    try {
      mkdirSync(join(root, "i18n"))
      mkdirSync(join(root, "components/public"), { recursive: true })
      writeFileSync(
        join(root, "i18n/admin-literal-allowlist.json"),
        JSON.stringify({
          shippedFiles: ["components/public/footer.tsx"],
          entries: [],
        })
      )
      writeFileSync(
        join(root, "components/public/footer.tsx"),
        "export const footer = null"
      )
      expect(discoverR1ShippedFiles(root)).toEqual([
        {
          sourcePath: "components/public/footer.tsx",
          shippedPath: "components/public/footer.tsx",
        },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
