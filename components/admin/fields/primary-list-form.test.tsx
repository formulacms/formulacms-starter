import { readInstalledBlockDefinition } from "@/convex/lib/blocks"
import { blockProfile } from "@/test-utils/block-profile"
import { describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { fireEvent, screen } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { v } from "convex/values"
import { validate } from "convex-helpers/validators"
import {
  installedBlockDefs,
  blockDefs,
  type Primitive,
  type Block,
} from "@/convex/lib/blocks"
import {
  group,
  image,
  link,
  list,
  richText,
  text,
} from "@/convex/lib/blocks/primitives"
import { writeBlockFields } from "@/convex/lib/richtext/write"
import { FieldsEditor } from "./field-editor"

// Snapshot an optional descriptor without requiring it to be installed.
const installedBlockDefinition = (type: string) => readInstalledBlockDefinition(type)

const mocks = vi.hoisted(() => ({ useQuery: vi.fn(() => undefined) }))
vi.mock("convex/react", () => ({ useQuery: mocks.useQuery }))

const pm = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "body",
          marks: [
            { type: "bold" },
            { type: "link", attrs: { href: "/relative-target" } },
          ],
        },
      ],
    },
  ],
})

describe("primary-list FieldsEditor writer seam", () => {
  it("writes a nested text edit and clears IDless image/link rows through the canonical block writer", blockProfile([]), () => {
    const previous = blockDefs["rich-text-body"]
    const previousInstalled = installedBlockDefinition("rich-text-body")
    const primary = group({
      cards: list(
        group({ title: text(), body: richText({ profile: "inline" }) }),
        { max: 2 }
      ),
      images: list(image(), { max: 2 }),
      links: list(link(), { max: 2 }),
    })
    const synthetic = {
      ...previous,
      primary,
      validator: v.object({
        id: v.string(),
        type: v.literal("rich-text-body"),
        enabled: v.boolean(),
        primary: primary.validator,
      }),
    }
    Reflect.set(blockDefs, "rich-text-body", synthetic)
    Reflect.set(installedBlockDefs, "rich-text-body", synthetic)
    try {
      const initial = {
        cards: [
          { title: "before", body: pm, itemId: "card-legacy" },
          { title: "sibling", body: pm, itemId: "card-sibling" },
        ],
        images: [{ url: "/legacy.png", alt: "Legacy image" }],
        links: [{ type: "external" as const, url: "/legacy-link" }],
      }
      const onChange = vi.fn<(value: Record<string, unknown>) => void>()
      const ControlledFields = () => {
        const [value, setValue] = useState<Record<string, unknown>>(initial)
        return (
          <FieldsEditor
            fields={primary.config.fields as Record<string, Primitive>}
            value={value}
            onChange={(next) => {
              onChange(next)
              setValue(next)
            }}
            basePath="primary"
            locale="en"
            blockType="rich-text-body"
          />
        )
      }
      const { container } = render(<ControlledFields />)

      fireEvent.change(screen.getByDisplayValue("before"), {
        target: { value: "after" },
      })
      const changed = onChange.mock.calls.at(-1)?.[0]
      expect(changed).toBeDefined()
      const linksSelect = container.querySelector(
        '[data-block-field-path="primary.links.0"] select'
      )
      expect(linksSelect).not.toBeNull()
      fireEvent.change(linksSelect!, { target: { value: "none" } })
      const clearedLink = onChange.mock.calls.at(-1)?.[0]
      expect(clearedLink).toBeDefined()
      const removeImage = container.querySelector(
        '[data-block-field-path="primary.images.0"] button[title]'
      )
      expect(removeImage).not.toBeNull()
      fireEvent.click(removeImage!)
      const emitted = onChange.mock.calls.at(-1)?.[0]
      expect(emitted).toBeDefined()
      if (!emitted) throw new Error("Expected primary form output")

      const cards = emitted.cards as Array<Record<string, unknown>>
      expect(cards[0]).toMatchObject({ title: "after", itemId: "card-legacy" })
      expect(cards[0]!.body).toBe(pm)
      expect(cards[1]).toEqual(initial.cards[1])
      const images = emitted.images as Array<Record<string, unknown>>
      const links = emitted.links as Array<Record<string, unknown>>
      expect(images[0]).toEqual({ itemId: expect.any(String) })
      expect(links[0]).toMatchObject({
        type: "none",
        itemId: expect.any(String),
      })
      expect(initial.cards[0]!.title).toBe("before")
      expect(initial.images[0]!.url).toBe("/legacy.png")
      expect(initial.links[0]!.url).toBe("/legacy-link")

      const block = {
        id: "form",
        type: "rich-text-body",
        enabled: true,
        primary: emitted,
      } as unknown as Block
      const canonical = writeBlockFields(block, "en", {
        createId: () => "allocated",
      }).value
      expect((canonical.primary as Record<string, unknown>).cards).toEqual(
        emitted.cards
      )
      expect((canonical.primary as Record<string, unknown>).images).toEqual(
        emitted.images
      )
      expect((canonical.primary as Record<string, unknown>).links).toEqual(
        emitted.links
      )
      expect(() =>
        validate(
          v.object({
            id: v.string(),
            type: v.literal("rich-text-body"),
            enabled: v.boolean(),
            primary: primary.validator,
          }),
          canonical
        )
      ).not.toThrow()
    } finally {
      Reflect.set(blockDefs, "rich-text-body", previous)
      Reflect.set(installedBlockDefs, "rich-text-body", previousInstalled)
    }
  })
})
