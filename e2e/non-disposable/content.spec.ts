import { expect, test } from "playwright/test"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import {
  adminLocale,
  adminMessages,
  adminTranslator,
  assertNotFoundWithNoindex,
  clientFor,
  localPath,
  ownerPage,
  pageTranslator,
  required,
} from "../support"

const curated = ["landing-page", "page", "post", "author"] as const

function pageIdFromEditor(editor: string): Id<"pages"> {
  const pathname = new URL(editor, "http://formulacms.invalid").pathname
  const match = /^\/admin\/pages\/([^/]+)$/.exec(pathname)
  if (!match) throw new Error("The E2E fixture must point to a Page editor")
  return decodeURIComponent(match[1]!) as Id<"pages">
}

async function publishThroughWarnings(
  page: import("playwright/test").Page,
  action?: string
) {
  await page.getByRole("button", { name: action ?? (await pageTranslator(page))("editor.page.publish"), exact: true }).click()
  const published = page.getByText((await pageTranslator(page))("editor.pageSave.published"), { exact: true })
  const warning = page.getByRole("heading", { name: (await pageTranslator(page))("editor.page.prePublish.warningsTitle") })
  await expect(published.or(warning)).toBeVisible()
  if (await warning.isVisible()) {
    await page.getByRole("button", { name: (await pageTranslator(page))("editor.page.prePublish.publishAnyway") }).click()
    await expect(published).toBeVisible()
  }
}

/**
 * V03. Preconditions: built English owner app with all four curated Content
 * Types active, an eligible member for Author, and a shipped slice type named
 * FR6_E2E_SLICE_LABEL. The scenario creates test-owned draft documents;
 * the operator owns their later removal.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("V03 creates curated content and enforces slice and publication readiness", async ({ browser }) => {
  const owner = await ownerPage(browser)
  const created: Record<string, string> = {}
  try {
    for (const type of curated) {
      await test.step(`create ${type}`, async () => {
        await owner.goto(`/admin/pages/new?type=${type}`)
        const locale = await adminLocale(owner)
        const t = adminTranslator(locale)
        // new-page-form.tsx lower-cases the content type's singular label.
        const label = adminMessages(locale).sidebar.contentType[type].singular.toLowerCase()
        await expect(
          owner.getByRole("heading", { name: t("pages.newForm.heading", { type: label }), exact: true })
        ).toBeVisible()
        await owner.getByLabel((await pageTranslator(owner))("pages.newForm.titleLabel")).fill(`FR6 ${type} ${Date.now()}`)
        await owner
          .getByRole("button", { name: t("pages.newForm.create", { type: label }), exact: true })
          .click()
        await expect(owner).toHaveURL(/\/admin\/pages\/[^/]+$/)
        created[type] = owner.url()
      })
    }

    await test.step("add, reorder, and remove typed slices without publishing", async () => {
      await owner.goto(created.page!)
      for (let index = 0; index < 2; index += 1) {
        await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.sliceBuilder.add") }).click()
        await owner.getByRole("button", { name: required("FR6_E2E_SLICE_LABEL") }).click()
      }
      // slice-builder.tsx interpolates the slice's registered label, which
      // FR6_E2E_SLICE_LABEL names.
      const moveUp = (await pageTranslator(owner))("editor.sliceBuilder.moveUp", {
        label: required("FR6_E2E_SLICE_LABEL"),
      })
      await expect(owner.getByRole("button", { name: moveUp, exact: true }).last()).toBeEnabled()
      await owner.getByRole("button", { name: moveUp, exact: true }).last().click()
      await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.sliceBuilder.remove") }).last().click()
      await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.sliceBuilder.removeConfirm.action") }).click()
      await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.save"), exact: true }).click()
      await expect(owner.getByText((await pageTranslator(owner))("editor.pageSave.saved"), { exact: true })).toBeVisible()
    })

    await test.step("an empty Post remains blocked until required body content is present", async () => {
      await owner.goto(created.post!)
      await expect(owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.publish"), exact: true })).toBeDisabled()
      const readiness = await (await clientFor(owner)).query(api.cms.pages.getPrePublishChecklist, { pageId: pageIdFromEditor(created.post!) })
      const bodyBlocker = readiness.blockers.find((item) => item.code === "missing_required_field" && item.field === "body")
      expect(bodyBlocker).toBeDefined()
      const message = (await pageTranslator(owner))("editor.prePublish.items.missingBody", { locale: bodyBlocker!.locales!.map((locale) => locale.toUpperCase()).join(", ") })
      await expect(owner.getByText(message, { exact: true })).toBeVisible()
    })
  } finally {
    await owner.context().close()
  }
})

/**
 * V03 continued. Preconditions: the image fixture has a rendered image field;
 * the byline Post is otherwise publication-ready; the named Author is a
 * publication-ready draft. These fixtures are test-owned. The scenario leaves
 * both relation fixtures withdrawn and soft-deletes its uploaded image after
 * removing the Working Draft reference.
 * Server: Playwright starts built Next by default and the caller owns Convex;
 * with `FR6_E2E_SERVER=external` the caller (in FR6, the D10 launcher) owns
 * both and Playwright only verifies the origin (see `playwright.config.ts`).
 */
test("V03 makes image-alt warnings explicit and blocks a draft Author byline", async ({ browser, request }) => {
  const imageEditor = required("FR6_E2E_V03_IMAGE_EDITOR")
  const imageFile = required("FR6_E2E_V03_IMAGE_FILE")
  const imageFilename = required("FR6_E2E_V03_IMAGE_FILENAME")
  const authorEditor = required("FR6_E2E_V03_AUTHOR_EDITOR")
  const authorTitle = required("FR6_E2E_V03_AUTHOR_TITLE")
  const postEditor = required("FR6_E2E_V03_POST_EDITOR")
  const postPath = localPath("FR6_E2E_V03_POST_PATH")
  const authorMarker = required("FR6_E2E_V03_AUTHOR_PUBLIC_MARKER")
  const imagePageId = pageIdFromEditor(imageEditor)
  const authorId = pageIdFromEditor(authorEditor)
  const postId = pageIdFromEditor(postEditor)
  const owner = await ownerPage(browser)
  try {
    const ownerClient = await clientFor(owner)

    await test.step("an uploaded content image requires an explicit alt-warning decision", async () => {
      await owner.goto(imageEditor)
      await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.imageField.choose") }).click()
      await owner.getByLabel((await pageTranslator(owner))("editor.mediaBrowser.uploadMedia")).setInputFiles(imageFile)
      await owner.getByRole("button", { name: imageFilename }).click()
      await expect(owner.getByLabel((await pageTranslator(owner))("editor.imageField.altText"))).toHaveValue("")
      await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.save"), exact: true }).click()
      await expect(owner.getByText((await pageTranslator(owner))("editor.pageSave.saved"), { exact: true })).toBeVisible()
      await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.publish"), exact: true }).click()
      await expect(owner.getByRole("heading", { name: (await pageTranslator(owner))("editor.page.prePublish.warningsTitle") })).toBeVisible()
      await expect(owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.prePublish.publishAnyway") })).toBeVisible()
      await owner.getByRole("button", { name: (await pageTranslator(owner))("common.cancel") }).click()
      await owner.getByLabel((await pageTranslator(owner))("editor.imageField.altText")).fill(`Alt ${imageFilename}`)
      await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.save"), exact: true }).click()
      await expect(owner.getByText((await pageTranslator(owner))("editor.pageSave.saved"), { exact: true })).toBeVisible()
    })

    await test.step("Media Library refuses a currently referenced image, then accepts it after removal", async () => {
      const media = await ownerClient.query(api.cms.media.getByName, {
        name: imageFilename,
      })
      if (!media) throw new Error("The V03 uploaded image is missing")
      const beforeMedia = await ownerClient.query(api.cms.media.getById, {
        id: media._id,
      })
      const beforeUsage = await ownerClient.query(api.cms.media.usage, {
        id: media._id,
      })
      const beforePage = await ownerClient.query(api.cms.pages.getForEdit, {
        id: imagePageId,
      })
      expect(beforeUsage.pages.map(({ _id }) => _id)).toContain(imagePageId)

      await owner.goto("/admin/media")
      await owner.getByRole("button", { name: imageFilename, exact: true }).click()
      // An image in use is refused at once, with no dialog.
      await owner.getByRole("button", { name: (await pageTranslator(owner))("inventory.mediaLibrary.trash") }).click()
      await expect(
        owner.getByText((await pageTranslator(owner))("inventory.mediaLibrary.referencedDeleteRefusal"), {
          exact: true,
        })
      ).toBeVisible()

      expect(
        await ownerClient.query(api.cms.media.getById, { id: media._id })
      ).toEqual(beforeMedia)
      expect(
        await ownerClient.query(api.cms.media.usage, { id: media._id })
      ).toEqual(beforeUsage)
      expect(
        await ownerClient.query(api.cms.pages.getForEdit, { id: imagePageId })
      ).toEqual(beforePage)

      await owner.goto(imageEditor)
      await owner.getByTitle((await pageTranslator(owner))("editor.imageField.remove")).click()
      await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.save"), exact: true }).click()
      await expect(owner.getByText((await pageTranslator(owner))("editor.pageSave.saved"), { exact: true })).toBeVisible()
      expect(await ownerClient.query(api.cms.media.usage, { id: media._id })).toEqual({
        settings: [],
        pages: [],
      })

      await owner.goto("/admin/media")
      await owner.getByRole("button", { name: imageFilename, exact: true }).click()
      await owner.getByRole("button", { name: (await pageTranslator(owner))("inventory.mediaLibrary.trash") }).click()
      await owner
        .getByRole("button", {
          name: (await pageTranslator(owner))("inventory.mediaLibrary.confirm"),
          exact: true,
        })
        .click()
      await expect(
        owner.getByText((await pageTranslator(owner))("inventory.mediaLibrary.movedToTrash"), { exact: true })
      ).toBeVisible()
      expect(
        await ownerClient.query(api.cms.media.getByName, { name: imageFilename })
      ).toBeNull()
      expect(
        (await ownerClient.query(api.cms.media.getById, { id: media._id }))
          ?.deletedAt
      ).toEqual(expect.any(Number))
    })

    await test.step("a draft Author blocks the otherwise-ready Post until that Author is published", async () => {
      await owner.goto(postEditor)
      await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.tabs.settings"), exact: true }).click()
      await owner.getByLabel((await pageTranslator(owner))("editor.settings.postByline")).fill(authorTitle)
      await owner.getByRole("option", { name: new RegExp(authorTitle, "i") }).click()
      await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.save"), exact: true }).click()
      await expect(owner.getByText((await pageTranslator(owner))("editor.pageSave.saved"), { exact: true })).toBeVisible()
      await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.publish"), exact: true }).click()
      await expect(
        owner.getByText(
          adminMessages(await adminLocale(owner)).editor.pageSave.publication.targetLocaleUnavailable,
          { exact: true }
        )
      ).toBeVisible()
      await assertNotFoundWithNoindex(request, postPath)

      await owner.goto(authorEditor)
      await publishThroughWarnings(owner)
      await owner.goto(postEditor)
      await publishThroughWarnings(owner)
      const publishedPost = await request.get(postPath)
      expect(publishedPost.ok()).toBe(true)
      expect(await publishedPost.text()).toContain(authorMarker)

      await owner.goto(authorEditor)
      await owner.getByTitle((await pageTranslator(owner))("editor.page.tabs.settings"), { exact: true }).click()
      await owner
        .getByRole("button", { name: (await pageTranslator(owner))("editor.settings.archive"), exact: true })
        .click()
      await expect(
        owner.getByText((await pageTranslator(owner))("editor.pageSave.archived"), { exact: true })
      ).toBeVisible()
      const beforeAuthor = await ownerClient.query(api.cms.pages.getForEdit, {
        id: authorId,
      })
      const beforePost = await ownerClient.query(api.cms.pages.getForEdit, {
        id: postId,
      })
      const previousPostSnapshotId = beforePost?.publication?.locales.find(
        ({ locale }) => locale === "en"
      )?.currentSnapshotId
      if (!beforePost || !("authorIds" in beforePost.page)) {
        throw new Error("The V03 Post fixture did not resolve as a Post")
      }
      expect(beforeAuthor?.page.status).toBe("archived")
      expect(beforePost.page.authorIds ?? []).toContain(authorId)
      expect(previousPostSnapshotId).toBeDefined()

      await owner
        .getByRole("button", {
          name: (await pageTranslator(owner))("editor.settings.moveToTrash"),
          exact: true,
        })
        .click()
      await owner
        .getByRole("button", { name: (await pageTranslator(owner))("editor.page.trash.action"), exact: true })
        .click()
      await expect(
        owner.getByText((await pageTranslator(owner))("editor.page.trash.publishedPostReference"), {
          exact: true,
        })
      ).toBeVisible()
      expect(
        await ownerClient.query(api.cms.pages.getForEdit, { id: authorId })
      ).toEqual(beforeAuthor)
      expect(
        await ownerClient.query(api.cms.pages.getForEdit, { id: postId })
      ).toEqual(beforePost)

      await owner.goto(postEditor)
      await owner.getByTitle((await pageTranslator(owner))("editor.page.tabs.settings"), { exact: true }).click()
      await owner
        .getByRole("button", { name: (await pageTranslator(owner))("editor.relations.remove"), exact: true })
        .click()
      await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.save"), exact: true }).click()
      await expect(owner.getByText((await pageTranslator(owner))("editor.pageSave.saved"), { exact: true })).toBeVisible()
      await publishThroughWarnings(owner, (await pageTranslator(owner))("editor.page.publishChanges"))
      const postWithoutAuthor = await ownerClient.query(api.cms.pages.getForEdit, {
        id: postId,
      })
      const currentPostSnapshotId = postWithoutAuthor?.publication?.locales.find(
        ({ locale }) => locale === "en"
      )?.currentSnapshotId
      if (!postWithoutAuthor || !("authorIds" in postWithoutAuthor.page)) {
        throw new Error("The V03 Post fixture did not resolve as a Post")
      }
      expect(postWithoutAuthor.page.authorIds ?? []).toEqual([])
      expect(currentPostSnapshotId).toBeDefined()
      expect(currentPostSnapshotId).not.toBe(previousPostSnapshotId)
      const updatedPost = await request.get(postPath)
      expect(updatedPost.ok()).toBe(true)
      expect(await updatedPost.text()).not.toContain(authorMarker)

      await owner.goto(authorEditor)
      await owner.getByTitle((await pageTranslator(owner))("editor.page.tabs.settings"), { exact: true }).click()
      await owner
        .getByRole("button", {
          name: (await pageTranslator(owner))("editor.settings.moveToTrash"),
          exact: true,
        })
        .click()
      await owner
        .getByRole("button", { name: (await pageTranslator(owner))("editor.page.trash.action"), exact: true })
        .click()
      await expect(
        owner.getByText((await pageTranslator(owner))("editor.page.trash.moved"), { exact: true })
      ).toBeVisible()
      expect(
        await ownerClient.query(api.cms.pages.getForEdit, { id: authorId })
      ).toBeNull()

      await owner.goto("/admin/trash")
      const authorTrashRow = owner.locator("div.divide-y > div").filter({
        has: owner.getByText(authorTitle, { exact: true }),
      })
      await expect(authorTrashRow).toHaveCount(1)
      await authorTrashRow
        .getByRole("button", { name: (await pageTranslator(owner))("inventory.trash.restore") })
        .click()
      await expect(
        owner.getByText(
          (await pageTranslator(owner))("inventory.trash.restored", { title: authorTitle }),
          { exact: true }
        )
      ).toBeVisible()

      await owner.goto(authorEditor)
      await owner
        .getByRole("button", { name: (await pageTranslator(owner))("editor.page.unarchive"), exact: true })
        .click()
      const restoredAuthor = await ownerClient.query(api.cms.pages.getForEdit, {
        id: authorId,
      })
      expect(restoredAuthor?.page.status).toBe("published")

      await owner.goto(postEditor)
      await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.moreActions") }).click()
      await owner.getByRole("menuitem", { name: (await pageTranslator(owner))("editor.page.unpublish") }).click()
      await owner
        .getByRole("alertdialog")
        .getByRole("button", {
          name: (await pageTranslator(owner))("pages.list.unpublish.confirm"),
          exact: true,
        })
        .click()
      await owner.goto(authorEditor)
      await owner.getByRole("button", { name: (await pageTranslator(owner))("editor.page.moreActions") }).click()
      await owner.getByRole("menuitem", { name: (await pageTranslator(owner))("editor.page.unpublish") }).click()
      await owner
        .getByRole("alertdialog")
        .getByRole("button", {
          name: (await pageTranslator(owner))("pages.list.unpublish.confirm"),
          exact: true,
        })
        .click()
    })
  } finally {
    await owner.context().close()
  }
})
