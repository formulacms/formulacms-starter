import { createElement } from "react"
import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { render } from "@/test-utils/admin-i18n"
import { ConfirmProvider } from "@/components/providers/confirm-provider"
import { group, list, richText, text } from "@/convex/lib/slices/primitives"
import { toast } from "sonner"
import { PageSaveRefusedError } from "@/components/admin/page-editor/lib/page-save-refused-error"
import type { FieldGenerate } from "./field-editor"
import { GroupFields } from "./field-editor"

vi.mock("../rich-text-editor", () => ({
  RichTextEditor: (props: {
    generate?: FieldGenerate
    label: string
    profile?: "inline" | "basic" | "full"
  }) =>
    createElement(
      "button",
      {
        type: "button",
        onClick: () =>
          void props.generate?.run(
            "editor brief",
            props.label,
            "richText",
            props.profile
          ),
      },
      "mock editor write"
    ),
}))

describe("title field generation binding", () => {
  test("passes title and itemTitle through editor and header Write callbacks", async () => {
    const run = vi.fn(async () => "generated title")
    const generate: FieldGenerate = {
      run,
      runRefine: vi.fn(async () => ""),
      runSlice: vi.fn(async () => ({ type: "section" }) as never),
    }
    const fields = {
      primary: group({
        questions: list(
          group({
            question: richText({
              contract: "title",
              heading: { role: "itemTitle" },
            }),
          })
        ),
      }),
    }
    const value = {
      primary: {
        questions: [{ question: "" }],
      },
    }

    render(
      <ConfirmProvider>
        <GroupFields
          def={fields.primary}
          value={value.primary}
          onChange={() => {}}
          locale="en"
          generate={generate}
        />
      </ConfirmProvider>
    )

    const question = document.querySelector(
      '[data-slice-field-path="primary.questions.0.question"]'
    )
    expect(question).not.toBeNull()
    const editorButton = await within(question as HTMLElement).findByRole(
      "button",
      { name: "mock editor write" }
    )
    fireEvent.click(editorButton)
    await waitFor(() => {
      expect(run).toHaveBeenCalledWith(
        "editor brief",
        "Question",
        "richText",
        "inline",
        "title",
        "itemTitle"
      )
    })

    fireEvent.click(
      within(question as HTMLElement).getByTitle("Write this field with AI")
    )
    const prompt = await screen.findByRole("textbox", { name: "Brief" })
    fireEvent.change(prompt, {
      target: { value: "header brief" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Write" }))
    await waitFor(() => {
      expect(run).toHaveBeenLastCalledWith(
        "header brief",
        "Question",
        "richText",
        "inline",
        "title",
        "itemTitle"
      )
    })
  })

  test.each(["inline", "basic", "full"] as const)(
    "does not forward a heading role from the %s profile to either Write callback",
    async (profile) => {
      const run = vi.fn(async () => "generated body")
      const generate: FieldGenerate = {
        run,
        runRefine: vi.fn(async () => ""),
        runSlice: vi.fn(async () => ({ type: "section" }) as never),
      }
      const fields = {
        primary: group({
          questions: list(
            group({
              question: richText({ profile }),
            })
          ),
        }),
      }
      const value = {
        primary: {
          questions: [{ question: "" }],
        },
      }

      render(
        <ConfirmProvider>
          <GroupFields
            def={fields.primary}
            value={value.primary}
            onChange={() => {}}
            locale="en"
            generate={generate}
          />
        </ConfirmProvider>
      )

      const question = document.querySelector(
        '[data-slice-field-path="primary.questions.0.question"]'
      )
      expect(question).not.toBeNull()
      const editorButton = await within(question as HTMLElement).findByRole(
        "button",
        { name: "mock editor write" }
      )
      fireEvent.click(editorButton)
      await waitFor(() => expect(run).toHaveBeenCalledTimes(1))

      fireEvent.click(
        within(question as HTMLElement).getByTitle("Write this field with AI")
      )
      const prompt = await screen.findByRole("textbox", { name: "Brief" })
      fireEvent.change(prompt, { target: { value: "header brief" } })
      fireEvent.click(screen.getByRole("button", { name: "Write" }))
      await waitFor(() => expect(run).toHaveBeenCalledTimes(2))

      expect(run).toHaveBeenNthCalledWith(
        1,
        "editor brief",
        "Question",
        "richText",
        profile,
        profile,
        undefined
      )
      expect(run).toHaveBeenNthCalledWith(
        2,
        "header brief",
        "Question",
        "richText",
        profile,
        profile,
        undefined
      )
    }
  )
})

describe("a refused pre-generation Save", () => {
  test.each([
    ["Write", "Write this field with AI", "Brief", "Write", "run", ""],
    [
      "Refine",
      "Refine this field with AI",
      "Instruction",
      "Refine",
      "runRefine",
      "Hello",
    ],
  ] as const)(
    "%s stays quiet for a refused Save and still reports other failures",
    async (_name, title, promptName, action, method, current) => {
      const toastError = vi.spyOn(toast, "error").mockReturnValue("")
      vi.spyOn(console, "error").mockImplementation(() => {})
      for (const [failure, toasts] of [
        [new PageSaveRefusedError(), 0],
        [new Error("route down"), 1],
      ] as const) {
        toastError.mockClear()
        const fail = vi.fn(async () => {
          throw failure
        })
        const generate: FieldGenerate = {
          run: vi.fn(),
          runRefine: vi.fn(),
          runSlice: vi.fn(),
          [method]: fail,
        }
        const view = render(
          <ConfirmProvider>
            <GroupFields
              def={group({ headline: text() })}
              value={{ headline: current }}
              onChange={() => {}}
              locale="en"
              generate={generate}
            />
          </ConfirmProvider>
        )
        fireEvent.click(view.getByTitle(title))
        const prompt = await screen.findByRole("textbox", { name: promptName })
        fireEvent.change(prompt, { target: { value: "something" } })
        fireEvent.click(screen.getByRole("button", { name: action }))
        await waitFor(() => expect(fail).toHaveBeenCalledOnce())
        await waitFor(() => expect(toastError).toHaveBeenCalledTimes(toasts))
        view.unmount()
      }
      vi.restoreAllMocks()
    }
  )
})
