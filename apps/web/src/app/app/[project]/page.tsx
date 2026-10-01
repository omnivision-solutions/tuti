import { prisma } from "@tuti/db";
import { ExternalLinkIcon } from "lucide-react";

import { PostStatusBadge } from "@/components/post-status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { portalUrl } from "@/lib/hosts";

export default async function FeedbackPage(props: PageProps<"/app/[project]">) {
  const { project: slug } = await props.params;
  const project = await prisma.project.findUniqueOrThrow({
    where: { slug },
    select: {
      posts: {
        where: { duplicateOfId: null },
        orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
        take: 100,
        select: {
          id: true,
          number: true,
          title: true,
          status: true,
          voteCount: true,
          board: { select: { name: true } },
          author: { select: { name: true } },
        },
      },
    },
  });
  const portal = portalUrl(slug);

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Feedback</h1>
          <p className="text-sm text-muted-foreground">Everything your users have posted, most-voted first.</p>
        </div>
        <a href={portal} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
          <ExternalLinkIcon />
          {new URL(portal).host}
        </a>
      </div>

      {project.posts.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No feedback yet</CardTitle>
            <CardDescription>
              Share your portal with users, or connect your app with single sign-on in Settings.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card size="sm">
          <CardContent className="flex flex-col divide-y">
            {project.posts.map((post) => (
              <div key={post.id} className="flex items-center gap-4 py-2.5 first:pt-0 last:pb-0">
                <span className="w-10 text-right font-semibold tabular-nums">{post.voteCount}</span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{post.title}</span>
                  <span className="text-xs text-muted-foreground">
                    #{post.number} · {post.board.name} · {post.author.name}
                  </span>
                </div>
                <PostStatusBadge status={post.status} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </>
  );
}
