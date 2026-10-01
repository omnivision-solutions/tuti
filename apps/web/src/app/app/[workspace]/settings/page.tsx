import { notFound } from "next/navigation";

import { SsoSettings } from "@/components/sso-settings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { portalUrl } from "@/lib/hosts";
import { getAdminWorkspace } from "@/server/members";

export default async function SettingsPage(props: PageProps<"/app/[workspace]/settings">) {
  const { workspace: slug } = await props.params;
  const workspace = await getAdminWorkspace(slug);
  if (!workspace) {
    // Members who aren't owners/admins get the same response as outsiders.
    notFound();
  }

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Owners and admins only.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Single sign-on (JWT)</CardTitle>
          <CardDescription>
            Let users of your app post and vote without creating a separate account. Your server signs a token for
            the logged-in user and sends them to your portal.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SsoSettings
            workspaceSlug={workspace.slug}
            enabled={workspace.ssoSecret !== null}
            ssoUrl={`${portalUrl(workspace.slug)}/sso`}
          />
        </CardContent>
      </Card>
    </>
  );
}
