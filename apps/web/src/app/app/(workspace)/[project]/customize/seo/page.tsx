import { notFound } from "next/navigation";

import { CustomizeShell } from "@/components/customize-shell";
import { SeoPreview, SeoSettings } from "@/components/seo-settings";
import { portalAddress } from "@/server/custom-domains";
import { getAdminProject } from "@/server/membership";
import { branding, SEO_DESCRIPTION_MAX, SEO_TITLE_MAX } from "@/server/operations/branding";

/** Customize → SEO: the portal's search listing and share image, beside how they show in a search result and a shared link. */
export default async function SeoPage(props: PageProps<"/app/[project]/customize/seo">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const brand = (await branding({ id: project.id }))!;
  return (
    <CustomizeShell
      projectSlug={slug} section="seo"
      preview={{
        custom: (
          <SeoPreview
            address={await portalAddress(slug)}
            name={project.name}
            saved={{ title: brand.seo.title, description: brand.seo.description, image: brand.seoImage?.url ?? null }}
          />
        ),
      }}
    >
      <SeoSettings
        projectSlug={slug}
        title={brand.seo.title}
        description={brand.seo.description}
        image={brand.seoImage}
        titleMax={SEO_TITLE_MAX}
        descriptionMax={SEO_DESCRIPTION_MAX}
      />
    </CustomizeShell>
  );
}
