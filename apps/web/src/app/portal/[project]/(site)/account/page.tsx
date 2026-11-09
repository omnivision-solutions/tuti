import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { EmailSettings } from "@/components/email-settings";
import { ItemList, ItemRow } from "@/components/item-list";
import { PageHeader } from "@/components/page-header";
import { PostStatusBadge } from "@/components/post-status-badge";
import { VisibilityBadge } from "@/components/visibility-badge";
import { SignInLink } from "@/components/sign-in-link";
import { SignOutButton } from "@/components/user-menu";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ResendVerificationButton } from "@/components/verify-email-banner";
import { appUrl } from "@/lib/hosts";
import { postPath } from "@/lib/post-urls";
import { accountEmails } from "@/server/operations/email-preferences";
import { accountPosts, whyNotEmailedAboutPosts } from "@/server/post-lists";
import { currentPostViewer } from "@/server/portal-access";
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
  const [{ preferences: saved, changelog }, { posts, votes }, whyNot, sso] = await Promise.all([
    accountEmails(project.id, session.user.id),
    // Only those they may still see (a post made private or the team's since isn't theirs to see).
    // As the page is seen: a team member previewing it signed out or as a reader sees what they would.
    currentPostViewer(project.id).then((viewer) => accountPosts(project.id, session.user.id, viewer)),
    // Switches only for people the project's emails about posts may reach (once confirmed); the rest are told why not.
    whyNotEmailedAboutPosts(project.id, session.user.id),
    prisma.ssoIdentity.findUnique({ where: { userId: session.user.id }, select: { id: true } }),
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

  // Two sections of one card: what they posted, what they voted for.
  const list = (id: string, title: string, items: typeof posts, empty: string) => (
    <section role="region" aria-labelledby={id} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
      <h2 id={id} className="font-semibold">
        {title}
      </h2>
      <div>
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
                badges={
                  <>
                    <VisibilityBadge visibility={post.visibility} />
                    <PostStatusBadge status={post.status} />
                  </>
                }
                meta={`${post.voteCount} ${post.voteCount === 1 ? "vote" : "votes"}`}
              />
            ))}
          </ItemList>
        )}
      </div>
    </section>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Account settings"
        // The address its emails go to (its SSO's): an SSO account's own is a placeholder, so none when the sign-on gave none.
        meta={changelog.email && <span className="break-all">Signed in as {changelog.email}</span>}
        actions={<SignOutButton />}
      />
      {/* The account's name, changed on the app: a portal's session can't change the account (lib/auth.ts). An account
          a project's single sign-on made can't sign in there; its name comes from that sign-in. */}
      <Card role="region" aria-labelledby="profile">
        <CardHeader>
          <CardTitle>
            <h2 id="profile">Profile</h2>
          </CardTitle>
          <CardDescription>Shown on your posts and comments.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          <p className="font-medium break-words">{session.user.name}</p>
          {!sso && (
            <a href={`${appUrl().origin}/app/account`} className="self-start text-muted-foreground underline underline-offset-4">
              Change your name in your Tuti account
            </a>
          )}
        </CardContent>
      </Card>
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
      <Card>
        <CardContent className="flex flex-col divide-y">
          {list("my-posts", "My posts", posts, "You haven't posted here yet.")}
          {list("my-votes", "My votes", votes, "You haven't voted on others' posts here yet.")}
        </CardContent>
      </Card>
    </div>
  );
}
