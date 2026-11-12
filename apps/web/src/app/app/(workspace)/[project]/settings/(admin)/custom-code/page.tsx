import { notFound } from "next/navigation";

import { CustomCodeSettings } from "@/components/custom-code-settings";
import { PortalSettingsPane } from "@/components/portal-settings-pane";
import { portalUrl } from "@/lib/hosts";
import { CUSTOM_CODE_MAX } from "@/lib/portal-look";
import { portalAddress } from "@/server/custom-domains";
import { portalPreview } from "@/server/customize";
import { getAdminProject } from "@/server/membership";
import { branding } from "@/server/operations/branding";

/** Settings → Portal → Custom code: the team's CSS for the portal, and HTML for it on their own address. */
export default async function CustomCodePage(props: PageProps<"/app/[project]/settings/custom-code">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [brand, address] = await Promise.all([branding({ id: project.id }), portalAddress(slug)]);
  return (
    <PortalSettingsPane page="custom-code" preview={await portalPreview(slug, "/")}>
      <CustomCodeSettings
        projectSlug={slug}
        css={brand!.customCss}
        html={brand!.customHtml}
        max={CUSTOM_CODE_MAX}
        ownAddress={address !== portalUrl(slug) ? address : null}
      />
    </PortalSettingsPane>
  );
}
