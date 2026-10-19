import { prisma } from "@tuti/db";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { STATUS_LABELS } from "@/components/post-status-badge";
import { postPath } from "@/lib/post-urls";
import { ROADMAP, roadmapColumns } from "@/server/operations/read";

/** What's planned, being built and done, from the posts' statuses. */
export default async function RoadmapPage(props: PageProps<"/portal/[project]/roadmap">) {
  const { project: slug } = await props.params;
  const project = await prisma.project.findUnique({ where: { slug }, select: { id: true } });
  if (!project) {
    notFound();
  }
  const columns = await roadmapColumns(project.id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Roadmap" description="What's planned, what we're building and what's done." />
      <div className="grid gap-6 md:grid-cols-3">
        {ROADMAP.map(({ status }, i) => {
          const posts = columns[i]!;
          return (
            <section key={status} aria-label={STATUS_LABELS[status]} className="flex flex-col gap-3">
              <h2 className="flex items-baseline gap-2 font-medium">
                {STATUS_LABELS[status]}
                <span className="text-sm text-muted-foreground">{posts.length}</span>
              </h2>
              {posts.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing here yet.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {posts.map((post) => (
                    <li key={post.number} className="rounded-xl border bg-card p-3 text-sm">
                      <Link href={postPath(post)} className="font-medium break-words hover:underline">
                        {post.title}
                      </Link>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {post.voteCount} {post.voteCount === 1 ? "vote" : "votes"} · {post.board.name}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
