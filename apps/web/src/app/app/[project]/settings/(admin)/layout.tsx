import { notFound } from "next/navigation";

import { getAdminProject } from "@/server/membership";

/** Every Settings page but Team & roles: owners and admins only. */
export default async function AdminSettingsLayout({ children, params }: LayoutProps<"/app/[project]/settings">) {
  if (!(await getAdminProject((await params).project))) {
    // Team members who aren't owners/admins get the same response as outsiders.
    notFound();
  }
  return children;
}
