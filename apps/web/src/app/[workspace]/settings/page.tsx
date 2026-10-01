import { ArrowLeftIcon } from "lucide-react";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";

import { SsoSettings } from "@/components/sso-settings";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAdminWorkspace } from "@/server/members";

// (A board can't use the slug "settings"; this static segment takes precedence.)
export default async function SettingsPage(props: PageProps<"/[workspace]/settings">) {
  const { workspace: slug } = await props.params;
  const workspace = await getAdminWorkspace(slug);
  if (!workspace) {
    // Same response whether the workspace doesn't exist or you just can't manage it.
    notFound();
  }

  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-start gap-1">
        <Link href={`/${workspace.slug}`} className={buttonVariants({ variant: "link", size: "sm", className: "px-0 text-muted-foreground" })}>
          <ArrowLeftIcon />
          {workspace.name}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Single sign-on (JWT)</CardTitle>
          <CardDescription>
            Let users of your app post and vote without creating a separate account. Your server signs a token for
            the logged-in user and sends them here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SsoSettings
            workspaceSlug={workspace.slug}
            enabled={workspace.ssoSecret !== null}
            ssoUrl={`${origin}/${workspace.slug}/sso`}
          />
        </CardContent>
      </Card>
    </div>
  );
}
