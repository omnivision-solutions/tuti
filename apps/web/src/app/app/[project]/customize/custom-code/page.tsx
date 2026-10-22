import { notFound } from "next/navigation";

import { CustomCodeSettings } from "@/components/custom-code-settings";
import { CustomizeShell } from "@/components/customize-shell";
import { portalUrl } from "@/lib/hosts";
import { CUSTOM_CODE_MAX } from "@/lib/portal-look";
import { portalAddress } from "@/server/custom-domains";
import { portalPreview } from "@/server/customize";
import { getAdminProject } from "@/server/membership";
import { branding } from "@/server/operations/branding";

import { sectionTitle } from "../sections";

/** Customize → Custom code: the team's CSS for the portal, and HTML for it on their own address. */
export default async function CustomCodePage(props: PageProps<"/app/[project]/customize/custom-code">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [brand, address] = await Promise.all([branding({ id: project.id }), portalAddress(slug)]);
  return (
    <CustomizeShell backHref={`/app/${slug}/customize`} title={sectionTitle("custom-code")} preview={await portalPreview(slug, "/")}>
      <CustomCodeSettings
        projectSlug={slug}
        css={brand!.customCss}
        html={brand!.customHtml}
        max={CUSTOM_CODE_MAX}
        ownAddress={address !== portalUrl(slug) ? address : null}
      />
    </CustomizeShell>
  );
}
