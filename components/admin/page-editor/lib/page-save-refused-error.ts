/**
 * Thrown by the page editor's AI producers when the Save they run first was
 * refused. The refusal already told the owner why (a toast), so the callers
 * that catch it stay quiet instead of adding a second, generic failure message.
 */
export class PageSaveRefusedError extends Error {
  constructor() {
    super("PAGE_SAVE_REFUSED")
    this.name = "PageSaveRefusedError"
  }
}
