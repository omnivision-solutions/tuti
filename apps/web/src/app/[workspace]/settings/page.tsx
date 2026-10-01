import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";

import { SsoSettings } from "@/components/sso-settings";
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
    <div className="flex flex-col gap-8">
      <div>
        <Link href={`/${workspace.slug}`} className="text-sm text-zinc-500 underline">
          ← {workspace.name}
        </Link>
        <h1 className="text-2xl font-semibold">Settings</h1>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Single sign-on (JWT)</h2>
        <p className="text-sm text-zinc-500">
          Let users of your app post and vote without creating a separate account. Your server signs a token for
          the logged-in user and sends them here.
        </p>
        <SsoSettings
          workspaceSlug={workspace.slug}
          enabled={workspace.ssoSecret !== null}
          ssoUrl={`${origin}/${workspace.slug}/sso`}
        />
      </section>
    </div>
  );
}
