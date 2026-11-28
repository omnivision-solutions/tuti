import type { Metadata } from "next";

import { PortalSettingsPane } from "@/components/portal-settings-pane";
import { DocsHomeSettings } from "@/components/docs-look-settings";
import { serverCaller } from "@/server/trpc/server";

export const metadata: Metadata = { title: "Docs home · Settings" };

/** Settings → Portal → Docs home: the heading at the top of the docs' home, and its popular articles. */
export default async function DocsHomePage(props: PageProps<"/app/[project]/settings/docs-home">) {
  const { project: slug } = await props.params;
  const trpc = await serverCaller();
  // Owners and admins only (settings.access): anyone else gets a 404.
  const [, brand, preview] = await Promise.all([
    trpc.settings.access({ project: slug }),
    trpc.branding.get({ project: slug }),
    trpc.customize.preview({ project: slug, path: "/docs" }),
  ]);
  return (
    <PortalSettingsPane page="docs-home" preview={preview}>
      <DocsHomeSettings projectSlug={slug} home={brand.docsHome} />
    </PortalSettingsPane>
  );
}
