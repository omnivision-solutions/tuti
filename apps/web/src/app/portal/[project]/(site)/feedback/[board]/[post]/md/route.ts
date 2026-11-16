import { prisma } from "@tuti/db";
import { type Doc, isEmptyDoc, toMarkdown } from "@tuti/content";

import { STATUS_LABELS } from "@/components/post-status-badge";
import { etaOnPortal, formatDate, formatMonth } from "@/lib/format";
import { postNumberFromParam, postPath } from "@/lib/post-urls";
import { displayDoc } from "@/server/content";
import { portalAddress } from "@/server/custom-domains";
import { mediaUrls } from "@/server/media-urls";
import { portalHref } from "@/server/portal-base";
import { canSeePost, SIGNED_OUT_VIEWER } from "@/server/post-visibility";

const board = { select: { slug: true, name: true, off: true, postVisibility: true } } as const;

/**
 * A post as Markdown, at <its path>.md (proxy.ts sends it here), for AI tools: what its page shows a signed-out
 * visitor (its title, status, when it's expected, votes, board, the changelog entry it shipped in, description and
 * comments), whoever asks. Internal notes are another table.
 */
export async function GET(_request: Request, { params }: RouteContext<"/portal/[project]/feedback/[board]/[post]/md">) {
  const { project, board: boardParam, post: param } = await params;
  const number = postNumberFromParam(param);
  const post =
    number !== null &&
    (await prisma.post.findFirst({
      where: { number, project: { slug: project } },
      include: {
        board,
        author: { select: { name: true } },
        comments: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, parentId: true, body: true, content: true, createdAt: true, asReader: true, authorId: true, author: { select: { name: true } } },
        },
        project: { select: { team: { select: { userId: true } } } },
        duplicateOf: { select: { number: true, title: true, visibility: true, authorId: true, board } },
        changelogEntries: {
          where: { entry: { publishedAt: { not: null } } },
          orderBy: { entry: { publishedAt: "desc" } },
          take: 1,
          select: { entry: { select: { title: true } } },
        },
      },
    }));
  // As the page: one a visitor may not see is missing, and so is one merged into a post they may not see.
  if (!post || !canSeePost(SIGNED_OUT_VIEWER, post) || (post.duplicateOf && !canSeePost(SIGNED_OUT_VIEWER, post.duplicateOf))) {
    return new Response("Not found", { status: 404 });
  }
  // Merged, retitled or moved: to the current post's .md. Not kept by any cache: the post may become private.
  const current = postPath(post.duplicateOf ?? post);
  if (post.duplicateOf || `/feedback/${boardParam}/${param}` !== current) {
    return new Response(null, { status: 308, headers: { location: await portalHref(`${current}.md`), "cache-control": "private, no-store" } });
  }

  const team = new Set(post.project.team.map((member) => member.userId));
  const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  const heading = (level: number, text: string) => ({ type: "heading", attrs: { level }, content: [{ type: "text", text }] });
  const body = displayDoc(post);
  const comments = post.comments.map((comment) => ({ ...comment, doc: displayDoc(comment) }));
  // As the page: each comment, then its replies (one level deep) under it, oldest first; a reply whose comment is gone is one of its own.
  const ids = new Set(comments.map((comment) => comment.id));
  const isReply = (comment: (typeof comments)[number]) => !!comment.parentId && ids.has(comment.parentId);
  const thread = comments
    .filter((comment) => !isReply(comment))
    .flatMap((comment) => [{ comment, reply: false }, ...comments.filter((reply) => isReply(reply) && reply.parentId === comment.id).map((reply) => ({ comment: reply, reply: true }))]);
  const doc: Doc = {
    type: "doc",
    content: [
      heading(1, post.title),
      paragraph(
        [
          `Status: ${STATUS_LABELS[post.status]}`,
          ...(post.eta && etaOnPortal(post.eta, post.status) ? [`Expected ${formatMonth(post.eta)}`] : []),
          `${post.voteCount} ${post.voteCount === 1 ? "vote" : "votes"}`,
          // A Team only board isn't named to readers, as on the page.
          ...(post.board.postVisibility === "TEAM" ? [] : [`Board: ${post.board.name}`]),
        ].join(" · "),
      ),
      ...(post.changelogEntries[0] ? [paragraph(`Shipped in ${post.changelogEntries[0].entry.title}`)] : []),
      paragraph(`Posted by ${post.author.name} on ${formatDate(post.createdAt)}`),
      ...(isEmptyDoc(body) ? [] : (body.content ?? [])),
      heading(2, `${comments.length} ${comments.length === 1 ? "comment" : "comments"}`),
      ...thread.flatMap(({ comment, reply }) => [
        // Who's speaking before their name, where a name (the reader's own choice) can't fake it: the page's Team badge.
        heading(reply ? 4 : 3, `${reply ? "Reply · " : ""}${team.has(comment.authorId) && !comment.asReader ? "Team" : "Reader"}: ${comment.author.name} · ${formatDate(comment.createdAt)}`),
        ...(comment.doc.content ?? []),
      ]),
    ],
  };
  return new Response(`${toMarkdown(doc, { mediaUrls: await mediaUrls(body, ...comments.map((comment) => comment.doc)) })}\n`, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      // Never from a shared cache: the post may become private, or its board turned off, at any time.
      "cache-control": "private, max-age=300",
      // Search engines index the post's page, not this copy of it.
      link: `<${await portalAddress(project)}${current}>; rel="canonical"`,
      ...(post.sample && { "x-robots-tag": "noindex" }),
    },
  });
}
