"use client"

const HYDRATION_EXTENSION_ATTRIBUTE_CLEANUP_SCRIPT = `
(() => {
  const exactNames = new Set(["cz-shortcut-listen"]);
  const prefixes = ["bis_", "__processed_"];
  const shouldRemove = (name) =>
    exactNames.has(name) || prefixes.some((prefix) => name.startsWith(prefix));
  const cleanElement = (element) => {
    for (const attr of Array.from(element.attributes)) {
      if (shouldRemove(attr.name)) element.removeAttribute(attr.name);
    }
  };
  const cleanTree = (root) => {
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) {
      return;
    }
    if (root.nodeType === Node.ELEMENT_NODE) cleanElement(root);
    const elements = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const element of elements) cleanElement(element);
  };
  cleanTree(document);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        const name = mutation.attributeName || "";
        if (shouldRemove(name)) cleanElement(mutation.target);
        continue;
      }
      for (const node of mutation.addedNodes) cleanTree(node);
    }
  });
  if (document.documentElement) {
    observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    window.setTimeout(() => observer.disconnect(), 5000);
  }
})();
`

/**
 * Some browser extensions mutate server-rendered DOM before React hydrates
 * (`bis_skin_checked`, `bis_register`, generated `__processed_*` attrs, etc.).
 * React can only suppress one element at a time, so clean known extension attrs
 * across the document before hydration compares the SSR DOM to the client tree.
 *
 * Next's documented inline-script pattern keeps the executable script in the
 * server HTML, but marks client-rendered copies as inert data blocks. That
 * prevents React from trying to insert an executable script during soft
 * navigation while preserving the pre-hydration cleanup on a full load.
 */
export function HydrationExtensionAttributeCleanup() {
  return (
    <script
      id="hydration-extension-attribute-cleanup"
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{
        __html: HYDRATION_EXTENSION_ATTRIBUTE_CLEANUP_SCRIPT,
      }}
    />
  )
}
