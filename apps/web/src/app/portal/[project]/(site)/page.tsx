import { notFound, redirect } from "next/navigation";

import { portalHomePath } from "@/server/portal-home";

/** The portal's home: what the team picked (Settings → Home page), the first board unless they did. */
export default async function PortalHome(props: PageProps<"/portal/[project]">) {
  const { project: slug } = await props.params;
  const path = await portalHomePath(slug);
  if (!path) {
    notFound();
  }
  redirect(path);
}
