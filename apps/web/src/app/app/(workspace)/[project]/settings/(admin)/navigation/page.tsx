import type { Metadata } from "next";

import { NavigationSettings } from "@/components/branding-settings";
import { PortalSettingsPane } from "@/components/portal-settings-pane";
import { PortalHomeSelect } from "@/components/portal-home-select";
import { SettingsCard } from "@/components/settings-card";
import { serverCaller } from "@/server/trpc/server";

export const metadata: Metadata = { title: "Navigation · Settings" };

/** Settings → Portal → Navigation: what the portal's address opens, links in its header, footer and docs sidebar. */
export default async function NavigationPage(props: PageProps<"/app/[project]/settings/navigation">) {
  const { project: slug } = await props.params;
  const trpc = await serverCaller();
  // Owners and admins only (settings.access): anyone else gets a 404.
  const [, brand, { home }, preview] = await Promise.all([
    trpc.settings.access({ project: slug }),
    trpc.branding.get({ project: slug }),
    trpc.portal.get({ project: slug }),
    trpc.customize.preview({ project: slug, path: "/" }),
  ]);
  return (
    <PortalSettingsPane page="navigation" preview={preview}>
      <div className="flex flex-col gap-4">
        {/* Saved as it's picked, apart from "Save changes". */}
        <SettingsCard>
          <PortalHomeSelect projectSlug={slug} home={home} />
        </SettingsCard>
        <NavigationSettings
          projectSlug={slug}
          headerLinks={brand.headerLinks}
          footerLinks={brand.footerLinks}
          sidebarLinks={brand.sidebarLinks}
        />
      </div>
    </PortalSettingsPane>
  );
}
