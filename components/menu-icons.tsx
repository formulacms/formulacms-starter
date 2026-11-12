import { MENU_ICON_DEFINITIONS } from "@/components/menu-icon-definitions";

/** Render a menu icon by its stored Lucide name; nothing if unknown/absent. */
export function MenuIcon({
  name,
  className,
}: {
  name?: string;
  className?: string;
}) {
  const def = name
    ? MENU_ICON_DEFINITIONS.find((icon) => icon.name === name)
    : undefined;
  if (!def) return null;
  return <def.component className={className} />;
}
