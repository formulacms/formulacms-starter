import { describe, expect, test } from "vitest";
import { buildFieldDoc, buildPMDoc, buildPMDocForContract, type PMMark } from "./build";
import { resolveFieldContract, type FieldContract, type RichTextContractConfig } from "./contracts";
import { validateDoc, PROFILE_SPECS, type RichTextProfile } from "./profiles";
import { validateStrict } from "./strict";

const PROFILES: RichTextProfile[] = ["inline", "basic", "full"];

describe("buildPMDoc", () => {
  test("produces a doc validateDoc accepts under every profile", () => {
    const sample =
      "First paragraph about the topic.\n\nSecond paragraph with more detail.\n\nClosing thought.";
    for (const profile of PROFILES) {
      const json = JSON.stringify(buildPMDoc(sample, profile));
      const result = validateDoc(json, profile);
      expect(result, `profile=${profile}`).toEqual({ ok: true });
    }
  });

  test("splits on blank lines into paragraph nodes", () => {
    const doc = buildPMDoc("one\n\ntwo\n\nthree", "basic");
    expect(doc.type).toBe("doc");
    expect(doc.content).toHaveLength(3);
    for (const p of doc.content) {
      expect(p.type).toBe("paragraph");
      expect(p.content?.[0]?.type).toBe("text");
    }
    expect(doc.content[0]?.content?.[0]?.text).toBe("one");
    expect(doc.content[2]?.content?.[0]?.text).toBe("three");
  });

  test("emits no marks on any text node by default (paragraph-only, mark-free)", () => {
    const doc = buildPMDoc(
      "A link **bold** _italic_ http://example.com inside.",
      "full",
    );
    const json = JSON.stringify(doc);
    expect(json.includes('"marks"')).toBe(false);
    // And no link/image/heading nodes snuck in either.
    expect(json.includes('"type":"link"')).toBe(false);
    expect(json.includes('"type":"image"')).toBe(false);
    expect(json.includes('"type":"heading"')).toBe(false);
  });

  test("uses only `doc`, `paragraph`, `text` node types (default)", () => {
    const doc = buildPMDoc("alpha\n\nbeta", "full");
    const seen = new Set<string>();
    function walk(n: { type?: unknown; content?: unknown }): void {
      if (typeof n.type === "string") seen.add(n.type);
      if (Array.isArray(n.content)) for (const c of n.content) walk(c);
    }
    walk(doc);
    expect([...seen].sort()).toEqual(["doc", "paragraph", "text"]);
    // Sanity: those three are in every profile's node allowlist.
    for (const profile of PROFILES) {
      for (const t of seen) {
        expect(PROFILE_SPECS[profile].nodes.has(t)).toBe(true);
      }
    }
  });

  describe("emphasis option", () => {
    test("parses **bold** into a bold mark", () => {
      const doc = buildPMDoc("Hello **world** today.", "inline", { emphasis: true });
      const nodes = doc.content[0]?.content ?? [];
      expect(nodes.map((n) => ({ text: n.text, marks: n.marks }))).toEqual([
        { text: "Hello ", marks: undefined },
        { text: "world", marks: [{ type: "bold" }] },
        { text: " today.", marks: undefined },
      ]);
    });

    test("parses *italic* and _italic_ into italic marks", () => {
      const a = buildPMDoc("plain *yes* plain", "inline", { emphasis: true });
      const b = buildPMDoc("plain _yes_ plain", "inline", { emphasis: true });
      for (const doc of [a, b]) {
        const nodes = doc.content[0]?.content ?? [];
        expect(nodes[1]?.marks).toEqual([{ type: "italic" }]);
        expect(nodes[1]?.text).toBe("yes");
      }
    });

    test("supports nested bold + italic", () => {
      const doc = buildPMDoc("a **b *c* d** e", "inline", { emphasis: true });
      const nodes = doc.content[0]?.content ?? [];
      // Expect: "a " | "b " bold | "c" bold+italic | " d" bold | " e"
      expect(nodes[2]?.text).toBe("c");
      expect(new Set(nodes[2]?.marks?.map((m) => m.type) ?? [])).toEqual(
        new Set(["bold", "italic"]),
      );
    });

    test("never emits link/image/code marks even with emphasis on", () => {
      const doc = buildPMDoc(
        "**bold** with http://example.com and `code` and [link](x)",
        "full",
        { emphasis: true },
      );
      const json = JSON.stringify(doc);
      expect(json.includes('"link"')).toBe(false);
      expect(json.includes('"code"')).toBe(false);
      expect(json.includes('"image"')).toBe(false);
      // Only `bold` and `italic` marks are ever emitted.
      const allowedMarks = new Set(["bold", "italic"]);
      function walk(n: { marks?: PMMark[]; content?: unknown }): void {
        for (const m of n.marks ?? []) expect(allowedMarks.has(m.type)).toBe(true);
        if (Array.isArray(n.content))
          for (const c of n.content) walk(c as { marks?: PMMark[]; content?: unknown });
      }
      walk(doc as unknown as { content?: unknown });
    });

    test("falls back to literal text on unbalanced markers", () => {
      const doc = buildPMDoc("an unfinished **mark here", "inline", { emphasis: true });
      const nodes = doc.content[0]?.content ?? [];
      expect(nodes).toHaveLength(1);
      expect(nodes[0]?.text).toBe("an unfinished **mark here");
      expect(nodes[0]?.marks).toBeUndefined();
    });

    test("emphasis output validates under every profile", () => {
      const sample = "First **bold** line.\n\nSecond *italic* line.";
      for (const profile of PROFILES) {
        const json = JSON.stringify(buildPMDoc(sample, profile, { emphasis: true }));
        expect(validateDoc(json, profile), `profile=${profile}`).toEqual({ ok: true });
      }
    });
  });

  test("collapses runs of blank lines and trims paragraph whitespace", () => {
    const doc = buildPMDoc("\n\n  one  \n\n\n\n\n  two  \n\n", "inline");
    expect(doc.content).toHaveLength(2);
    expect(doc.content[0]?.content?.[0]?.text).toBe("one");
    expect(doc.content[1]?.content?.[0]?.text).toBe("two");
  });

  test("falls back to an empty paragraph for empty/whitespace input", () => {
    const doc = buildPMDoc("   \n\n  ", "inline");
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].type).toBe("paragraph");
    // An empty paragraph has no `content` (or empty) — never a zero-length text node.
    const p = doc.content[0] as { content?: unknown[] };
    if (Array.isArray(p.content)) {
      for (const c of p.content) {
        expect((c as { text?: string }).text).not.toBe("");
      }
    }
    // And still validates.
    for (const profile of PROFILES) {
      expect(validateDoc(JSON.stringify(doc), profile)).toEqual({ ok: true });
    }
  });

  test("preserves single-newlines inside a paragraph as a hardBreak when allowed", () => {
    // hardBreak is in every profile, but the simplest correct behavior is to
    // join soft-wrapped lines into one paragraph with a space. Either is fine;
    // assert just that the result is one paragraph and validates.
    const doc = buildPMDoc("first line\nsecond line\n\nnext paragraph", "inline");
    expect(doc.content).toHaveLength(2);
    expect(validateDoc(JSON.stringify(doc), "inline")).toEqual({ ok: true });
  });
});

describe("buildFieldDoc", () => {
  const sliceTitle = { contract: "title" as const, heading: { role: "sliceTitle" as const } };
  const itemTitle = { contract: "title" as const, heading: { role: "itemTitle" as const, parent: "items" } };

  test("builds canonical title levels from configured roles", () => {
    for (const [config, level] of [[sliceTitle, 2], [itemTitle, 3]] as const) {
      const output = buildFieldDoc("A title", config);
      const json = JSON.stringify(output);
      expect((output as { content: Array<{ type: string; attrs?: { level: number } }> }).content[0]).toMatchObject({ type: "heading", attrs: { level } });
      expect(validateStrict(resolveFieldContract(config), json)).toEqual({ ok: true });
    }
    const overridden = buildFieldDoc("A title", sliceTitle, "itemTitle");
    expect((overridden as { content: Array<{ attrs?: { level: number } }> }).content[0]?.attrs?.level).toBe(3);
    expect((overridden as { content: Array<{ attrs?: { parent?: string } }> }).content[0]?.attrs?.parent).toBeUndefined();
  });

  test("preserves parent while applying an explicit role", () => {
    const output = buildFieldDoc("A title", { contract: "title", heading: { role: "sliceTitle", parent: "primary" } }, "itemTitle");
    expect(validateStrict(resolveFieldContract({ contract: "title", heading: { role: "itemTitle", parent: "primary" } }), JSON.stringify(output))).toEqual({ ok: true });
    expect((output as { content: Array<{ attrs?: { level?: number } }> }).content[0]?.attrs?.level).toBe(3);
  });

  test("builds strict canonical paragraph documents for legacy profiles", () => {
    for (const contract of ["inline", "basic", "full"] as const) {
      const output = buildFieldDoc("First **bold** line.\n\nSecond *italic* line.", contract, undefined, { emphasis: true });
      expect(validateStrict(resolveFieldContract(contract), JSON.stringify(output))).toEqual({ ok: true });
    }
  });

  test("keeps empty input and turns every title newline into one space in the canonical heading", () => {
    const empty = buildFieldDoc("", sliceTitle);
    expect(validateStrict(resolveFieldContract(sliceTitle), JSON.stringify(empty))).toEqual({ ok: true });
    const multiline = buildFieldDoc("one\n\ntwo\n", sliceTitle);
    const content = (multiline as { content: Array<{ content?: Array<{ type: string }> }> }).content[0]?.content ?? [];
    expect(content.filter((node) => node.type === "hardBreak")).toHaveLength(0);
    expect(content).toEqual([{ type: "text", text: "one two" }]);
    expect(validateStrict(resolveFieldContract(sliceTitle), JSON.stringify(multiline))).toEqual({ ok: true });
  });

  test("keeps typed spaces in a title so a controlled input can round-trip each key", () => {
    // Review P1 (2026-11-04): a whole-string trim turned typing "What is" into "Whatis".
    for (const typed of ["What ", "What is ", " leading", "two  spaces"]) {
      const content = (buildFieldDoc(typed, sliceTitle) as { content: Array<{ content?: Array<{ text?: string }> }> }).content[0]?.content ?? [];
      expect(content).toEqual([{ type: "text", text: typed }]);
    }
    const edges = (buildFieldDoc("\n Title \n", sliceTitle) as { content: Array<{ content?: Array<{ text?: string }> }> }).content[0]?.content ?? [];
    expect(edges).toEqual([{ type: "text", text: "Title" }]);
  });

  test("joins long newline runs in linear time", () => {
    // Review r2 P2 (2026-11-04): an end-anchored regex took 136 s on 1,000 newlines.
    const started = performance.now();
    const output = buildFieldDoc(`a${"\n".repeat(5000)} \n b${" \n".repeat(5000)}`, sliceTitle);
    expect(performance.now() - started).toBeLessThan(1000);
    expect((output as { content: Array<{ content?: unknown[] }> }).content[0]?.content).toEqual([{ type: "text", text: "a b" }]);
  });

  test("parses emphasis while treating JSON and HTML-looking inputs as literal text", () => {
    const emphasized = buildFieldDoc("A **bold** and *italic* title", sliceTitle, undefined, { emphasis: true });
    expect(validateStrict(resolveFieldContract(sliceTitle), JSON.stringify(emphasized))).toEqual({ ok: true });
    for (const literal of ['{"type":"doc","content":[]}', "<h2>literal</h2>"]) {
      const output = buildFieldDoc(literal, sliceTitle);
      expect(JSON.stringify(output)).toContain(JSON.stringify(literal));
      expect(validateStrict(resolveFieldContract(sliceTitle), JSON.stringify(output))).toEqual({ ok: true });
    }
  });

  test("accepts the supported 10000-character title input", () => {
    const output = buildFieldDoc("x".repeat(10000), sliceTitle);
    expect(validateStrict(resolveFieldContract(sliceTitle), JSON.stringify(output))).toEqual({ ok: true });
  });

  test("matches the frozen compatibility oracle byte for byte", () => {
    const oracle = {"titleSlice":{"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Hero title"}]}]},"titleItem":{"type":"doc","content":[{"type":"heading","attrs":{"level":3},"content":[{"type":"text","text":"First line Second "},{"type":"text","text":"line","marks":[{"type":"bold"}]}]}]},"titleEmpty":{"type":"doc","content":[{"type":"heading","attrs":{"level":2}}]},"titleMultiline":{"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"one two"}]}]},"titleEmphasis":{"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"A "},{"type":"text","text":"bold","marks":[{"type":"bold"}]},{"type":"text","text":" and "},{"type":"text","text":"italic","marks":[{"type":"italic"}]},{"type":"text","text":" title"}]}]},"titleLiteralJson":{"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"{\"type\":\"doc\",\"content\":[]}"}]}]},"titleLiteralHtml":{"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"<h2>literal</h2>"}]}]},"legacyInline":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"one two"}]},{"type":"paragraph","content":[{"type":"text","text":"three"}]}]},"legacyBasic":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"one two"}]},{"type":"paragraph","content":[{"type":"text","text":"three"}]}]},"legacyFull":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"one two"}]},{"type":"paragraph","content":[{"type":"text","text":"three"}]}]}} as const;
    const cases: Array<[keyof typeof oracle, string, FieldContract | RichTextContractConfig, role?: Parameters<typeof buildFieldDoc>[2], options?: Parameters<typeof buildFieldDoc>[3]]> = [
      ["titleSlice", "Hero title", { contract: "title", heading: { role: "sliceTitle" } }],
      ["titleItem", "First line\nSecond **line**", { contract: "title", heading: { role: "itemTitle" } }, undefined, { emphasis: true }],
      ["titleEmpty", "", { contract: "title", heading: { role: "sliceTitle" } }],
      ["titleMultiline", "one\ntwo", { contract: "title", heading: { role: "sliceTitle" } }],
      ["titleEmphasis", "A **bold** and *italic* title", { contract: "title", heading: { role: "sliceTitle" } }, undefined, { emphasis: true }],
      ["titleLiteralJson", '{"type":"doc","content":[]}', { contract: "title", heading: { role: "sliceTitle" } }],
      ["titleLiteralHtml", "<h2>literal</h2>", { contract: "title", heading: { role: "sliceTitle" } }],
      ["legacyInline", "one\ntwo\n\nthree", "inline", undefined, { emphasis: true }],
      ["legacyBasic", "one\ntwo\n\nthree", "basic", undefined, { emphasis: true }],
      ["legacyFull", "one\ntwo\n\nthree", "full", undefined, { emphasis: true }],
    ];
    for (const [key, text, config, role, options] of cases) {
      const current = buildPMDocForContract(text, config as RichTextContractConfig, options);
      const fieldDoc = buildFieldDoc(text, config, role, options);
      expect(JSON.stringify(fieldDoc), key).toBe(JSON.stringify(oracle[key]));
      expect(JSON.stringify(current), `${key} wrapper`).toBe(JSON.stringify(oracle[key]));
      expect(JSON.stringify(fieldDoc), `${key} delegation`).toBe(JSON.stringify(current));
    }
  });
});

describe("buildFieldDoc markdown option", () => {
  const md = "## Heading\n\nSome **bold** text.\n\n- one\n- two\n\n1. first\n2. second";

  test("converts ATX headings, bullet lists, ordered lists and emphasis for a contract that allows them", () => {
    const doc = buildFieldDoc(md, "full", undefined, { emphasis: true, markdown: true });
    expect(doc.content.map((node) => node.type)).toEqual([
      "heading",
      "paragraph",
      "bulletList",
      "orderedList",
    ]);
    expect(doc.content[0]).toMatchObject({ attrs: { level: 2 } });
    expect(JSON.stringify(doc)).toContain('"type":"bold"');
    expect(validateStrict("full", JSON.stringify(doc))).toEqual({ ok: true });
  });

  test("clamps a heading level into the contract's allowed levels", () => {
    const doc = buildFieldDoc("# Top\n\n###### Deep", "basic", undefined, { markdown: true });
    expect(doc.content.map((node) => node.type)).toEqual(["heading", "heading"]);
    expect(doc.content.map((node) => (node as { attrs: { level: number } }).attrs.level)).toEqual([2, 3]);
    expect(validateStrict("basic", JSON.stringify(doc))).toEqual({ ok: true });
  });

  test("keeps today's paragraphs for a contract with no headings or lists, and when the option is off", () => {
    const inline = buildFieldDoc(md, "inline", undefined, { emphasis: true, markdown: true });
    expect(inline.content.every((node) => node.type === "paragraph")).toBe(true);
    const off = buildFieldDoc(md, "full", undefined, { emphasis: true });
    expect(off.content.every((node) => node.type === "paragraph")).toBe(true);
    const plain = buildFieldDoc("one\n\ntwo", "full", undefined, { emphasis: true, markdown: true });
    expect(JSON.stringify(plain)).toBe(JSON.stringify(buildFieldDoc("one\n\ntwo", "full", undefined, { emphasis: true })));
  });

  test("leaves a title untouched", () => {
    const doc = buildFieldDoc("## Not a heading", { contract: "title", heading: { role: "sliceTitle" } }, undefined, { emphasis: true, markdown: true });
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]!.type).toBe("heading");
  });
});
