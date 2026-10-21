import { notFound, redirect } from "next/navigation";

import { portalHomePath } from "@/server/portal-home";
import { portalLinks } from "@/server/portal-base";

/** The portal's home: what the team picked (Customize → Home page), the first board unless they did. */
export default async function PortalHome(props: PageProps<"/portal/[project]">) {
  const { project: slug } = await props.params;
  const path = await portalHomePath(slug);
  if (!path) {
    notFound();
  }
  redirect((await portalLinks())(path));
}
