import type { Metadata } from "next";

import { CustomCodeSettings } from "@/components/custom-code-settings";
import { PortalSettingsPane } from "@/components/portal-settings-pane";
import { portalUrl } from "@/lib/hosts";
import { CUSTOM_CODE_MAX } from "@/lib/portal-look";
import { serverCaller } from "@/server/trpc/server";

export const metadata: Metadata = { title: "Custom code · Settings" };

/** Settings → Portal → Custom code: the team's CSS for the portal, and HTML for it on their own address. */
export default async function CustomCodePage(props: PageProps<"/app/[project]/settings/custom-code">) {
  const { project: slug } = await props.params;
  const trpc = await serverCaller();
  // Owners and admins only (settings.access): anyone else gets a 404.
  const [, brand, { portalUrl: address }, preview] = await Promise.all([
    trpc.settings.access({ project: slug }),
    trpc.branding.get({ project: slug }),
    trpc.project.get({ project: slug }),
    trpc.customize.preview({ project: slug, path: "/" }),
  ]);
  return (
    <PortalSettingsPane page="custom-code" preview={preview}>
      <CustomCodeSettings
        projectSlug={slug}
        css={brand.customCss}
        html={brand.customHtml}
        max={CUSTOM_CODE_MAX}
        ownAddress={address !== portalUrl(slug) ? address : null}
      />
    </PortalSettingsPane>
  );
}
