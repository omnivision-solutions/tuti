import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { ChevronUpIcon, LightbulbIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";

import { EmailSettings } from "@/components/email-settings";
import { AccountSections } from "@/components/account-sections";
import { PortalAvatar } from "@/components/portal-avatar";
import { PortalPageHeader } from "@/components/portal-page-header";
import { StatusLabel } from "@/components/post-status-badge";
import { buttonVariants } from "@/components/ui/button";
import { VoteCount } from "@/components/vote-button";
import { VisibilityBadge } from "@/components/visibility-badge";
import { SignInLink } from "@/components/sign-in-link";
import { SignOutButton } from "@/components/user-menu";
import { ResendVerificationButton } from "@/components/verify-email-banner";
import { appUrl } from "@/lib/hosts";
import { postPath } from "@/lib/post-urls";
import { accountEmails } from "@/server/operations/email-preferences";
import { accountPosts, whyNotEmailedAboutPosts } from "@/server/post-lists";
import { currentPostViewer } from "@/server/portal-access";
import { firstBoardPath } from "@/server/portal-home";
import { getSession } from "@/server/session";
import { portalLinks } from "@/server/portal-base";

/** The signed-in person on this portal: who they're signed in as, their name (and Sign out), which emails the project sends them, and their posts and votes here. */
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
  const [{ preferences: saved, changelog }, { posts, votes }, whyNot, sso, boards] = await Promise.all([
    accountEmails(project.id, session.user.id),
    // Only those they may still see (a post made private or the team's since isn't theirs to see).
    // As the page is seen: a team member previewing it signed out or as a reader sees what they would.
    currentPostViewer(project.id).then((viewer) => accountPosts(project.id, session.user.id, viewer)),
    // Switches only for people the project's emails about posts may reach (once confirmed); the rest are told why not.
    whyNotEmailedAboutPosts(project.id, session.user.id),
    prisma.ssoIdentity.findUnique({ where: { userId: session.user.id }, select: { id: true } }),
    // The boards to browse, as /feedback finds them: none (a changelog-only portal), no link to them.
    firstBoardPath(slug),
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

  // A section of the page, its heading outside its card, as the section list jumps to it (AccountSections).
  const section = (id: string, title: string, description: ReactNode, children: ReactNode) => (
    // Focusable (not in the Tab order): the section list moves focus here, as a hash link would.
    <section id={id} tabIndex={-1} role="region" aria-labelledby={`${id}-title`} className="flex scroll-mt-[calc(var(--portal-header-height,4rem)+1.5rem)] flex-col gap-3 outline-none">
      <div className="flex flex-col gap-0.5">
        <h2 id={`${id}-title`} className="font-heading text-lg font-semibold">
          {title}
        </h2>
        {description && <p className="text-[0.9375rem] text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
  // What they posted, what they voted for: rows on the paper, each with its votes and status; none, a soft fill with the way to the boards.
  const list = (items: typeof posts, empty: string, Icon: typeof ChevronUpIcon) =>
    items.length === 0 ? (
      <div className="flex flex-col items-center gap-3 rounded-xl bg-secondary px-4 py-8 text-center">
        <span aria-hidden className="grid size-10 place-items-center rounded-lg bg-card text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <p className="text-[0.9375rem] text-muted-foreground">{empty}</p>
        {boards && (
          <Link href={at("/feedback")} className={buttonVariants({ variant: "ghost", className: "hover:bg-secondary-hover" })}>
            Browse ideas
          </Link>
        )}
      </div>
    ) : (
      // Hairlines only between rows.
      <ul className="flex flex-col divide-y">
        {items.map((post) => (
          <li key={post.id} className="flex items-center gap-3 py-3">
            {post.status === "COMPLETED" ? (
              <VoteCount count={post.voteCount} shape="chip" />
            ) : (
              <p className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-secondary px-2.5 text-sm font-semibold tabular-nums">
                <ChevronUpIcon aria-hidden className="size-3.5 text-muted-foreground" />
                <span aria-hidden>{post.voteCount}</span>
                <span className="sr-only">
                  {post.voteCount} {post.voteCount === 1 ? "vote" : "votes"}
                </span>
              </p>
            )}
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
              <Link href={at(postPath(post))} className="min-w-0 flex-1 basis-48 text-[0.9375rem] break-words hover:underline">
                {post.title}
              </Link>
              <VisibilityBadge visibility={post.visibility} />
              <StatusLabel status={post.status} />
            </div>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="flex flex-col">
      <PortalPageHeader
        title="Account"
        // The address its emails go to (its SSO's): an SSO account's own is a placeholder, so none when the sign-on gave none.
        description={changelog.email && <span className="break-all">Signed in as {changelog.email}</span>}
      />
      <div className="mt-5 flex flex-col gap-8 md:mt-8 md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:gap-10 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-12">
        <AccountSections
          sections={[
            { id: "profile", title: "Profile" },
            { id: "emails", title: "Emails" },
            { id: "posts", title: "Your posts", count: posts.length },
            { id: "votes", title: "Your votes", count: votes.length },
          ]}
        />
        <div className="flex min-w-0 flex-col gap-8 sm:gap-10">
          {/* The account's name, changed on the app: a portal's session can't change the account (lib/auth.ts). An account
              a project's single sign-on made can't sign in there; its name comes from that sign-in. Sign out at the row's end. */}
          {section(
            "profile",
            "Profile",
            "Shown on your posts and comments.",
            <div className="flex items-center gap-3 rounded-xl bg-card px-4 py-3.5 shadow-card ring-1 ring-card-edge sm:gap-4 sm:px-5 sm:py-4">
              <PortalAvatar person={{ name: session.user.name, image: session.user.image ?? null }} className="size-10" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
                <p className="text-[0.9375rem] font-medium break-words">{session.user.name}</p>
                {!sso && (
                  <a href={`${appUrl().origin}/app/account`} className="self-start text-primary underline underline-offset-4">
                    Change your name in your Tuti account
                  </a>
                )}
              </div>
              <SignOutButton />
            </div>,
          )}
          {section(
            "emails",
            "Emails",
            `What ${project.name} emails you about.`,
            !never || (never === "team" && changelogShown) ? (
              <EmailSettings
                projectSlug={slug}
                projectName={project.name}
                saved={saved}
                posts={!never}
                // A proven address, as audienceReach asks before emailing about posts (whyNot "unconfirmed" otherwise).
                canStop={changelog.proven}
                changelog={changelogShown}
                notice={
                  (never === "team" || !changelog.proven) && (
                    <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                      {never === "team" && why.team}
                      {!changelog.proven && (
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <p>Confirm your email address to get these.</p>
                          <ResendVerificationButton email={session.user.email} callbackURL={at("/account")} />
                        </div>
                      )}
                    </div>
                  )
                }
              />
            ) : (
              <div className="rounded-xl bg-card px-4 py-3.5 text-sm text-muted-foreground shadow-card ring-1 ring-card-edge sm:px-5 sm:py-4">{why[never]}</div>
            ),
          )}
          {section("posts", "Your posts", null, list(posts, "You haven't posted here yet.", LightbulbIcon))}
          {section("votes", "Your votes", null, list(votes, "You haven't voted on others' posts here yet.", ChevronUpIcon))}
        </div>
      </div>
    </div>
  );
}

