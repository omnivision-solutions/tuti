import type { Metadata } from "next";

import { PortalSettingsPane } from "@/components/portal-settings-pane";
import { SeoPreview, SeoSettings } from "@/components/seo-settings";
import { SEO_DESCRIPTION_MAX, SEO_TITLE_MAX } from "@/server/operations/branding";
import { serverCaller } from "@/server/trpc/server";

export const metadata: Metadata = { title: "SEO · Settings" };

/** Settings → Portal → SEO: the portal's search listing and share image, beside how they show in a search result and a shared link. */
export default async function SeoPage(props: PageProps<"/app/[project]/settings/seo">) {
  const { project: slug } = await props.params;
  const trpc = await serverCaller();
  // Owners and admins only (settings.access): anyone else gets a 404.
  const [, project, brand] = await Promise.all([trpc.settings.access({ project: slug }), trpc.project.get({ project: slug }), trpc.branding.get({ project: slug })]);
  return (
    <PortalSettingsPane
      page="seo"
      preview={{
        custom: (
          <SeoPreview
            address={project.portalUrl}
            name={project.name}
            saved={{ title: brand.seo.title, description: brand.seo.description, image: brand.seoImage?.url ?? null }}
          />
        ),
      }}
    >
      <SeoSettings
        projectSlug={slug}
        name={project.name}
        title={brand.seo.title}
        description={brand.seo.description}
        image={brand.seoImage}
        titleMax={SEO_TITLE_MAX}
        descriptionMax={SEO_DESCRIPTION_MAX}
      />
    </PortalSettingsPane>
  );
}
