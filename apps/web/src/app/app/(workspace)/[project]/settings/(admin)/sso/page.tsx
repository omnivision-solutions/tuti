import type { Metadata } from "next";

import { SsoSettings } from "@/components/sso-settings";
import { SettingsPane } from "@/components/settings-card";
import { portalUrl } from "@/lib/hosts";
import { serverCaller } from "@/server/trpc/server";

export const metadata: Metadata = { title: "Single sign-on · Settings" };

/** Settings → Single sign-on: the JWT secret the team's app signs its users in with. */
export default async function SsoSettingsPage(props: PageProps<"/app/[project]/settings/sso">) {
  const { project: slug } = await props.params;
  // Owners and admins only (sso.get's access): anyone else gets a 404.
  const { enabled, signInUrl } = await (await serverCaller()).sso.get({ project: slug });
  return (
    <SettingsPane title="Single sign-on">
      <SsoSettings projectSlug={slug} enabled={enabled} portal={portalUrl(slug)} signInUrl={signInUrl} />
    </SettingsPane>
  );
}
