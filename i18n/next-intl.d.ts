export {}

declare module "next-intl" {
  interface AppConfig {
    Messages: typeof import("../messages/admin/en.json")
  }
}
