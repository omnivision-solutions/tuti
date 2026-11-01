import { prisma } from "@tuti/db";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ProfileForm } from "@/components/account-forms";
import { EmailSettings } from "@/components/email-settings";
import { PageHeader } from "@/components/page-header";
import { PostStatusBadge } from "@/components/post-status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { postPath } from "@/lib/post-urls";
import { emailPreferences } from "@/server/operations/email-preferences";
import { accountPosts } from "@/server/post-lists";
import { getSession } from "@/server/session";
import { portalLinks } from "@/server/portal-base";

/** The signed-in person on this portal: their name, which emails the project sends them, and their posts and votes here. */
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
  const [saved, { posts, votes }] = await Promise.all([emailPreferences(project.id, session.user.id), accountPosts(project.id, session.user.id)]);

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
          <ul className="flex flex-col gap-2">
            {items.map((post) => (
              <li key={post.id} className="flex items-center gap-3 text-sm">
                <PostStatusBadge status={post.status} />
                <Link href={at(postPath(post))} className="min-w-0 flex-1 break-words hover:underline">
                  {post.title}
                </Link>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {post.voteCount} {post.voteCount === 1 ? "vote" : "votes"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Account settings" />
      <ProfileForm name={session.user.name} />
      <EmailSettings projectSlug={slug} projectName={project.name} saved={saved} />
      {list("my-posts", "My posts", posts, "You haven't posted here yet.")}
      {list("my-votes", "My votes", votes, "You haven't voted on others' posts here yet.")}
    </div>
  );
}
