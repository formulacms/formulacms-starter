import type { ReactElement } from "react"
import type { BlockSimPageProps } from "./page"

export async function renderBlockSimDevPage(
  props: BlockSimPageProps
): Promise<ReactElement> {
  const { BlockSimDevPage } = await import("./dev-page")
  return <BlockSimDevPage {...props} />
}
