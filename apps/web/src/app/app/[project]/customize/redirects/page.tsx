import { prisma } from "@tuti/db";
import { notFound } from "next/navigation";

import { CustomizeShell } from "@/components/customize-shell";
import { RedirectsSettings } from "@/components/redirects-settings";
import { MAX_REDIRECTS } from "@/lib/portal-redirects";
import { portalPreview } from "@/server/customize";
import { getAdminProject } from "@/server/membership";

import { sectionTitle } from "../sections";

/** Customize → Redirects: old addresses on the portal sent on to new ones. */
export default async function RedirectsPage(props: PageProps<"/app/[project]/customize/redirects">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const redirects = await prisma.portalRedirect.findMany({ where: { projectId: project.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, from: true, to: true } });
  return (
    <CustomizeShell backHref={`/app/${slug}/customize`} title={sectionTitle("redirects")} preview={await portalPreview(slug, "/")}>
      <RedirectsSettings projectSlug={slug} redirects={redirects} max={MAX_REDIRECTS} />
    </CustomizeShell>
  );
}
