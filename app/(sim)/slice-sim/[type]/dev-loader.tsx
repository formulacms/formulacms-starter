import type { ReactElement } from "react"
import type { SliceSimPageProps } from "./page"

export async function renderSliceSimDevPage(
  props: SliceSimPageProps
): Promise<ReactElement> {
  const { SliceSimDevPage } = await import("./dev-page")
  return <SliceSimDevPage {...props} />
}
