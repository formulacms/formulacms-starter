const URL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const URL_ENCODED_CONTROLS = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i

export function hasUnsafeUrlCharacters(value: string): boolean {
  return (
    URL_CONTROL_CHARACTERS.test(value) ||
    value !== value.trim() ||
    value.includes("\\")
  )
}

export function safeMailtoHref(value: string): string | undefined {
  const recipientList = value.slice("mailto:".length).split("?", 1)[0]
  const hasQuery = value.includes("?")
  if (
    (!recipientList && !hasQuery) ||
    recipientList.startsWith("//") ||
    recipientList.includes(":") ||
    /[\s<>]/.test(recipientList) ||
    URL_ENCODED_CONTROLS.test(value)
  ) {
    return undefined
  }
  return value
}

export function safeTelHref(value: string): string | undefined {
  const numberAndParams = value.slice("tel:".length)
  const [number, ...params] = numberAndParams.split(";")
  if (
    !number ||
    !/[0-9]/.test(number) ||
    !/^[+0-9().*#,\-\s]+$/.test(number) ||
    params.some(
      (param) => !/^(?:ext|isub|phone-context)=[+a-z0-9.-]+$/i.test(param)
    ) ||
    URL_ENCODED_CONTROLS.test(value)
  ) {
    return undefined
  }
  return value
}

/** Menu contact links require ordinary phone numbers or recipient addresses. */
export function isContactHref(value: string): boolean {
  if (hasUnsafeUrlCharacters(value)) return false
  if (/^tel:/i.test(value)) {
    const numberAndParams = value.slice("tel:".length)
    const number = numberAndParams.split(";", 1)[0] ?? ""
    return (
      /^\+?[0-9(). -]+(?:;ext=[0-9]+)?$/i.test(numberAndParams) &&
      number.replace(/[^0-9]/g, "").length >= 3
    )
  }
  if (!/^mailto:/i.test(value) || safeMailtoHref(value) === undefined) return false
  const recipients = value.slice("mailto:".length).split("?", 1)[0]
  return recipients.split(",").every((recipient) => {
    try {
      return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(decodeURIComponent(recipient))
    } catch {
      return false
    }
  })
}
