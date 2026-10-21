import { notFound } from "next/navigation";

import { getAdminProject } from "@/server/membership";

/** Customize: how the portal looks, each part beside a preview of it. Owners and admins only, like Settings. */
export default async function CustomizeLayout({ children, params }: LayoutProps<"/app/[project]/customize">) {
  if (!(await getAdminProject((await params).project))) {
    notFound();
  }
  return children;
}
