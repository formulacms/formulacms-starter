import { MenuEditor } from "@/components/admin/menu/menu-editor";

export default async function MenuEditorPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <MenuEditor slug={slug} />;
}
