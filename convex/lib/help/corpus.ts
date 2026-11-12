// convex/lib/help/corpus.ts
// Curated, editor-facing help corpus for the in-app assistant (Phase 1 of the
// agentic command bar). This is intentionally SMALL: it fits in the model's
// context window, so the help assistant needs no vector store / embeddings.
//
// Audience: the SITE OWNER using the admin, not a developer. Write each entry in
// plain task language ("how do I…"), short (2–5 sentences). Describe only what
// the release 0.1 starter ships, using the admin's own wording (messages/admin/
// en.json). When a feature ships or changes, update the matching entry.
//
// Server-safe: no UI / React imports, so the Convex help action can import it.
// The live slice-type list is NOT hardcoded here (it grows via ADR-0016); the
// prompt builder (workflow.ts) appends the purposes of the installed slice
// types at call time.

export interface HelpEntry {
  /** Stable kebab-case id. */
  id: string
  /** Short human title, surfaced as a citation source in the answer panel. */
  title: string
  /** Keywords for cheap pre-filtering before the model call. */
  tags: string[]
  /** The answer body, plain language for the site owner. */
  body: string
}

export const HELP_CORPUS: HelpEntry[] = [
  {
    id: "create-page",
    title: "Create and edit a page",
    tags: ["page", "create", "new", "edit", "add page"],
    body: "Go to Content and choose New content. Enter a title and create the page. You can also import a .md file. If the AI module is on, Write page with AI plans a page from a short brief and saves it as a draft. Open any page from the Content list to edit it. The editor shows a live preview next to the fields.",
  },
  {
    id: "slug-and-urls",
    title: "Page addresses",
    tags: ["slug", "url", "path", "nested", "parent", "breadcrumb", "address"],
    body: "In the Settings tab of the page editor, the URL identifier is the last part of the page's address. Two pages cannot share an address. A parent page nests the address and builds breadcrumbs. The editor tells you when an address is taken and asks for another URL identifier. When Multilingual is on, each language can have its own URL identifier.",
  },
  {
    id: "add-slices",
    title: "Add, reorder, and remove blocks",
    tags: ["slice", "section", "block", "add", "reorder", "layout", "builder"],
    body: "Pages are built from blocks, the typed content sections that stack to form the page. In the page editor, choose Add block, pick a type, and fill its fields. Drag blocks to reorder them, or use Move up and Move down. Remove takes the block out of this language's draft. Choose Save to keep the change. Each block type has a fixed set of fields, so content stays structured.",
  },
  {
    id: "locales-and-translation",
    title: "Work in multiple languages",
    tags: ["locale", "language", "multilingual", "i18n", "fr", "en", "ar"],
    body: "Multilingual is a module. Turn it on in Settings › Modules to publish in more than one language. Then add languages, choose the default and remove a language in Settings › Languages. One page holds every language: use the language tabs in the page editor to write each one. With Multilingual off, the site has one language. Settings › Languages shows it, with a link to turn on Multilingual in Modules.",
  },
  {
    id: "write-with-ai",
    title: "Draft a page with AI",
    tags: ["ai", "write", "generate", "draft", "copy", "wizard"],
    body: "Write page with AI is on the New page screen when the AI module is on. Describe the page in a short brief. The assistant plans a structure you can edit, then writes each section. Review the sections and choose Accept chosen. They are then saved to your draft, and nothing is published. Set a house tone with Brand voice in Settings › General.",
  },
  {
    id: "translate-page-with-ai",
    title: "Translate a page with AI",
    tags: [
      "ai",
      "translate",
      "translation",
      "language",
      "multilingual",
      "not translated",
    ],
    body: "Translate page needs Multilingual and the AI module on, with your API key set (see Settings › AI). In the page editor, open a language tab whose status is Not translated, choose Translate from EN (the code of the page's source language), then Start. It works only on an empty language. When the job is done, choose Review translation to read the text, then Accept to save it to that language's draft, or Dismiss to drop it. Nothing is published.",
  },
  {
    id: "rich-text",
    title: "Format text (rich text)",
    tags: [
      "rich text",
      "format",
      "bold",
      "italic",
      "link",
      "table",
      "heading",
      "editor",
    ],
    body: "Rich-text fields have a formatting toolbar: headings, bold, italic, lists, links, tables and more. Choose Link to link a page, a URL or a media file. Choose Insert table to add a table. Different fields allow different amounts of formatting, depending on the design.",
  },
  {
    id: "publish-a-page",
    title: "Publish a page",
    tags: [
      "publish",
      "draft",
      "live",
      "unpublish",
      "status",
      "archive",
      "checklist",
    ],
    body: "A page is a draft until you publish it. Before publishing, the editor checks the page: fix every blocker, and accept warnings with Publish anyway. Publish and Unpublish are in the Content list and in the editor. Archived pages are hidden from the public site. The History tab lists published versions. Restore draft copies one into your drafts, and the live site changes only when you publish.",
  },
  {
    id: "media-library",
    title: "Manage images (media library)",
    tags: [
      "media",
      "image",
      "upload",
      "photo",
      "library",
      "folder",
      "alt",
      "crop",
    ],
    body: "In Media you can upload images, paste an image, or import one from a URL. Create folders to group images. Open an image to set its folder and tags. Choose Edit image to set its crop and focal point. You write alt text where you place the image on a page. Moving an image to Trash removes it from the library, and it cannot be restored yet. An image still used on a page cannot be removed.",
  },
  {
    id: "menus",
    title: "Edit navigation menus",
    tags: ["menu", "navigation", "nav", "header", "footer", "links"],
    body: "Menus use one shared structure and destination set, with labels, descriptions, headings, and image alt text written for each language under Menus. The default language controls items, panels, blocks, order, links, and images; other language tabs change text only. The Menus screen has Main navigation and Footer navigation. Main navigation also serves the phone menu. Choose Add navigation item, then set its link to Page, URL or No link. Choose Panel to open a panel menu with columns and blocks.",
  },
  {
    id: "redirects",
    title: "Set up redirects",
    tags: ["redirect", "301", "302", "moved", "broken link"],
    body: "Redirects is a module. If it is off, turn it on in Settings › Modules. Choose Add redirect, choose the language in the Locale field, then set From (an existing page or a custom path starting with /) and To (a page or an external URL). Choose 301 for permanent or 302 for temporary. A redirect to a page follows that page if its address changes. A new redirect can take up to 15 seconds to become active.",
  },
  {
    id: "trash-restore",
    title: "Delete and restore (trash)",
    tags: ["delete", "trash", "remove", "restore", "recover"],
    body: "Move to trash sends a page to Trash and does not erase it. Archive the page first, then choose Move to trash. Open Trash and choose Restore to bring the page back. Permanent deletion is not available yet, so pages stay in Trash.",
  },
  {
    id: "seo",
    title: "SEO and social previews",
    tags: [
      "seo",
      "meta",
      "description",
      "title",
      "open graph",
      "og",
      "social",
      "search",
    ],
    body: "The page editor has an SEO tab for each language with a meta title and a meta description. Under Social & indexing you set the social title, description and image URL, shared by all languages, and you can hide the page from search engines. Settings › General holds the logo, favicon and the default social-share (OG) image.",
  },
  {
    id: "settings-overview",
    title: "Site settings",
    tags: ["settings", "configure", "general", "site name", "logo", "email"],
    body: "Settings has General (site name and description, site address, contact details, social links, brand voice (when the AI module is on), logo, favicon, social image and public-site update checks), Languages, AI (shown when the AI module is on), Email, Modules, Account (your admin language) and Content Types. formulacms has one owner and one admin role, so there are no members or roles to manage.",
  },
  {
    id: "ai-setup",
    title: "Turn on AI features",
    tags: [
      "ai",
      "openrouter",
      "anthropic",
      "openai",
      "api key",
      "model",
      "configure ai",
      "byok",
      "enable",
    ],
    body: "Turn the AI module on in Settings › Modules. AI needs a key set as an environment variable on your Convex deployment: OPENROUTER_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY. Settings › AI shows which keys are found and lets you choose the provider and model for each assistant. formulacms never stores your key. Content you send to an assistant goes to its provider, which bills you per use.",
  },
  {
    id: "what-is-a-slice",
    title: "What is a block?",
    tags: ["slice", "what is", "concept", "section", "component"],
    body: "A block is one typed section of a page, like a hero, a feature grid, or an FAQ. Each block type defines exactly which fields it has, so you fill in a known structure instead of free-form content. You build a page by stacking blocks in the order you want. Developers add new block types.",
  },
]
