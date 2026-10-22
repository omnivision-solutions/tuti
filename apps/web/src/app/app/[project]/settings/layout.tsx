import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { SubNav } from "@/components/sub-nav";
import { getAdminProject } from "@/server/membership";

/**
 * Settings that don't change how the portal looks (those are in Customize): who can read it,
 * single sign-on, integrations, the API and webhooks, and exporting. Owners and admins only.
 */
export default async function SettingsLayout({ children, params }: LayoutProps<"/app/[project]/settings">) {
  const { project: slug } = await params;
  if (!(await getAdminProject(slug))) {
    // Team members who aren't owners/admins get the same response as outsiders.
    notFound();
  }
  const base = `/app/${slug}/settings`;
  return (
    <>
      <PageHeader title="Settings" description="Owners and admins only. How your portal looks is in Customize." />
      <SubNav
        label="Settings"
        items={[
          { title: "Access", href: base },
          { title: "Single sign-on", href: `${base}/sso` },
          { title: "Integrations", href: `${base}/integrations` },
          { title: "Developers", href: `${base}/developers` },
          { title: "Export", href: `${base}/export` },
        ]}
      />
      {children}
    </>
  );
}
