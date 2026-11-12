import { createElement } from "react"

function Image({ src, alt, className, style, width, height }) {
  return createElement("img", {
    src,
    alt: alt ?? "",
    className,
    style,
    width,
    height,
  })
}

export default Image

export function getImageProps(props) {
  return { props }
}
