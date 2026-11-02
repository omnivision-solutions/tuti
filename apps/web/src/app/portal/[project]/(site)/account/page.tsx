import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ProfileForm } from "@/components/account-forms";
import { EmailSettings } from "@/components/email-settings";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { PostStatusBadge } from "@/components/post-status-badge";
import { SignInLink } from "@/components/sign-in-link";
import { SignOutButton } from "@/components/user-menu";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ResendVerificationButton } from "@/components/verify-email-banner";
import { postPath } from "@/lib/post-urls";
import { accountEmails } from "@/server/operations/email-preferences";
import { accountPosts, whyNotEmailedAboutPosts } from "@/server/post-lists";
import { getSession } from "@/server/session";
import { portalLinks } from "@/server/portal-base";

/** The signed-in person on this portal: who they're signed in as (and Sign out), their name, which emails the project sends them, and their posts and votes here. */
export default async function PortalAccountPage(props: PageProps<"/portal/[project]/account">) {
  const at = await portalLinks();
  const session = await getSession();
  if (!session) {
    redirect(at(`/sign-in?${new URLSearchParams({ next: "/account" })}`));
  }
  const { project: slug } = await props.params;
  const project = await prisma.project.findUnique({ where: { slug }, select: { id: true, name: true } });
  if (!project) {
    notFound();
  }
  const [{ preferences: saved, changelog }, { posts, votes }, whyNot] = await Promise.all([
    accountEmails(project.id, session.user.id),
    accountPosts(project.id, session.user.id),
    // Switches only for people the project's emails about posts may reach (once confirmed); the rest are told why not.
    whyNotEmailedAboutPosts(project.id, session.user.id),
  ]);
  const never = whyNot === "unconfirmed" ? null : whyNot;
  // Its switch wherever the changelog is emailed to their address (changelogReach): the team's too, who get it like anyone.
  const changelogShown = changelog.reach !== null && changelog.reach !== "private" && emailConfigured();
  const why = {
    team: <p>{project.name} doesn&apos;t email its team about posts.</p>,
    elsewhere: (
      <p>
        This account is signed in through another site&apos;s single sign-on, so {project.name} doesn&apos;t email it about posts.{" "}
        <SignInLink className="text-foreground underline underline-offset-4">Sign in</SignInLink> to choose your emails here.
      </p>
    ),
    notReader: <p>{project.name}&apos;s portal is private, and it doesn&apos;t email this account about posts.</p>,
    noAddress: <p>{project.name}&apos;s sign-in didn&apos;t give this account an email address, so it can&apos;t be emailed about posts.</p>,
  };

  const list = (id: string, title: string, items: typeof posts, empty: string) => (
    <Card role="region" aria-labelledby={id}>
      <CardHeader>
        <CardTitle>
          <h2 id={id}>{title}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ItemList>
            {items.map((post) => (
              <ItemRow
                key={post.id}
                title={
                  <Link href={at(postPath(post))} className="hover:underline">
                    {post.title}
                  </Link>
                }
                badges={<PostStatusBadge status={post.status} />}
                meta={`${post.voteCount} ${post.voteCount === 1 ? "vote" : "votes"}`}
              />
            ))}
          </ItemList>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Account settings"
        // The address its emails go to (its SSO's): an SSO account's own is a placeholder, so none when the sign-on gave none.
        meta={changelog.email && `Signed in as ${changelog.email}`}
        actions={<SignOutButton />}
      />
      <ProfileForm name={session.user.name} />
      {!never || (never === "team" && changelogShown) ? (
        <EmailSettings
          projectSlug={slug}
          projectName={project.name}
          saved={saved}
          posts={!never}
          // A proven address, as audienceReach asks before emailing about posts (whyNot "unconfirmed" otherwise).
          canStop={changelog.proven}
          changelog={changelogShown}
          notice={
            <>
              {never === "team" && <div className="text-sm text-muted-foreground">{why.team}</div>}
              {!changelog.proven && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                  <p>Confirm your email address to get these.</p>
                  <ResendVerificationButton email={session.user.email} callbackURL={at("/account")} />
                </div>
              )}
            </>
          }
        />
      ) : (
        <Card role="region" aria-labelledby="emails">
          <CardHeader>
            <CardTitle>
              <h2 id="emails">Emails</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">{why[never]}</CardContent>
        </Card>
      )}
      {list("my-posts", "My posts", posts, "You haven't posted here yet.")}
      {list("my-votes", "My votes", votes, "You haven't voted on others' posts here yet.")}
    </div>
  );
}
