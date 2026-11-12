import { describe, expect, test } from "vitest";
import { getSchema } from "@tiptap/core";
import { extensionsForProfile } from "./extensions";

/**
 * Schema round-trip guard: the entire reason we store `pageId` on the Link
 * mark is so the editor re-displays the chosen page on edit *and* the renderer
 * can re-resolve the slug. If TipTap drops these attrs on PM-JSON ↔ Node
 * conversion (e.g. someone removes them from `addAttributes`), the picker
 * silently fails to preselect and slug-rename resilience degrades to the
 * cached href. Test runs without a DOM — pure prosemirror-model.
 */

function makeDocWithLinkAttrs(attrs: Record<string, unknown>) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "link",
            marks: [{ type: "link", attrs }],
          },
        ],
      },
    ],
  };
}

describe("Link mark schema round-trip", () => {
  test("pageId, noFollow, sponsored, ugc survive PM-JSON → Node → PM-JSON", () => {
    const schema = getSchema(extensionsForProfile("basic"));
    const docJson = makeDocWithLinkAttrs({
      href: "/cached",
      pageId: "pageABC",
      noFollow: true,
      sponsored: true,
      ugc: true,
      target: "_blank",
    });

    const node = schema.nodeFromJSON(docJson);
    const back = node.toJSON();

    const mark = back.content[0].content[0].marks[0];
    expect(mark.type).toBe("link");
    expect(mark.attrs.href).toBe("/cached");
    expect(mark.attrs.pageId).toBe("pageABC");
    expect(mark.attrs.noFollow).toBe(true);
    expect(mark.attrs.sponsored).toBe(true);
    expect(mark.attrs.ugc).toBe(true);
    expect(mark.attrs.target).toBe("_blank");
  });

  test("an external-only link round-trips with our extra attrs null", () => {
    const schema = getSchema(extensionsForProfile("basic"));
    const docJson = makeDocWithLinkAttrs({ href: "https://example.com" });

    const node = schema.nodeFromJSON(docJson);
    const back = node.toJSON();
    const mark = back.content[0].content[0].marks[0];

    expect(mark.attrs.href).toBe("https://example.com");
    // Defaults come from addAttributes — null means "not set", not absent.
    expect(mark.attrs.pageId).toBeNull();
    expect(mark.attrs.noFollow).toBeNull();
    expect(mark.attrs.sponsored).toBeNull();
    expect(mark.attrs.ugc).toBeNull();
  });
});
