import { prisma } from "@tuti/db";
import { isEmptyDoc } from "@tuti/content";
import { RichText } from "@tuti/content/react";
import { ArrowLeftIcon, ArrowUpRightIcon, XIcon } from "lucide-react";
import Link from "next/link";

import { CommentForm } from "@/components/comment-form";
import { MovePostSelect } from "@/components/move-post-select";
import { PostEtaSelect, PostOwnerSelect } from "@/components/post-planning";
import { Property, PostVoters } from "@/components/post-sidebar";
import { PostStatusSelect } from "@/components/post-status-select";
import { buttonVariants } from "@/components/ui/button";
import { asking, timeAgo } from "@/lib/format";
import { displayDoc } from "@/server/content";
import { mediaUrls } from "@/server/media-urls";
import { emailedOnCompletion } from "@/server/operations/code-changes";
import { postVoters, votersToEmail, voterTotals } from "@/server/post-lists";

/**
 * Feedback's pane: the post a row opened (`number`), beside the list, to triage without leaving it. Its
 * description, its properties (as on its page), its voters and a reply as the team; "Open full page" for
 * the rest. `close` is the list without it.
 */
export async function FeedbackPane({
  projectSlug,
  projectId,
  askingProperty,
  number,
  close,
}: {
  projectSlug: string;
  projectId: string;
  askingProperty: string | null;
  number: number;
  close: string;
}) {
  const [post, boards, team] = await Promise.all([
    // A number past what a post's can be (a mistyped address) is no post, not an error.
    number <= 2_147_483_647
      ? prisma.post.findUnique({
          where: { projectId_number: { projectId, number } },
          include: { board: { select: { slug: true, name: true } }, author: { select: { name: true } }, owner: { select: { id: true } } },
        })
      : null,
    prisma.board.findMany({ where: { projectId }, orderBy: { createdAt: "asc" }, select: { slug: true, name: true } }),
    prisma.teamMember.findMany({ where: { projectId }, orderBy: { createdAt: "asc" }, select: { userId: true, user: { select: { name: true } } } }),
  ]);
  if (!post) {
    return (
      <p className="text-sm text-muted-foreground">
        There&apos;s no post #{number} here.{" "}
        <Link href={close} scroll={false} className="underline underline-offset-4">
          Back to the list
        </Link>
      </p>
    );
  }
  const [totals, voters, emails, toEmail] = await Promise.all([
    voterTotals(projectId, askingProperty, [post.id]),
    postVoters(projectId, askingProperty, post.id),
    emailedOnCompletion(projectId, [post.id]),
    votersToEmail(projectId, post.id),
  ]);
  const total = totals.get(post.id);
  const doc = displayDoc(post);
  return (
    // Scrolled into view on a phone: just below the app's bar (3rem), not under it.
    <section aria-label={`Post #${post.number}`} data-feedback-pane className="flex scroll-mt-14 flex-col gap-4 text-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Link href={close} scroll={false} aria-label="Close" title="Close (Esc)" className={buttonVariants({ variant: "ghost", size: "icon-sm", className: "-ml-2" })}>
          <ArrowLeftIcon className="lg:hidden" />
          <XIcon className="max-lg:hidden" />
        </Link>
        <span className="min-w-0 flex-1 truncate">
          #{post.number} · {post.board.name}
        </span>
        <Link href={`/app/${projectSlug}/p/${post.number}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
          Open full page
          <ArrowUpRightIcon />
        </Link>
      </div>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold break-words">{post.title}</h2>
        <span className="text-muted-foreground">
          {post.author.name} · {timeAgo(post.createdAt)} · {post.voteCount} {post.voteCount === 1 ? "vote" : "votes"}
          {total !== undefined && ` · ${asking(total, askingProperty!)}`}
        </span>
      </div>
      {!isEmptyDoc(doc) && <RichText doc={doc} mediaUrls={await mediaUrls(doc)} className="rich-text break-words" />}
      {post.duplicateOfId ? (
        <p className="text-muted-foreground">Merged into another post: open its page to see where.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 border-t pt-4">
            <Property label="Status">
              <PostStatusSelect
                projectSlug={projectSlug}
                postId={post.id}
                status={post.status}
                completing={{ title: post.title, emails: emails.get(post.id) ?? 0 }}
                className="w-full"
              />
            </Property>
            <Property label="Board">
              <MovePostSelect projectSlug={projectSlug} postId={post.id} boardSlug={post.board.slug} boards={boards} className="w-full max-w-none" />
            </Property>
            <Property label="Owner">
              <PostOwnerSelect projectSlug={projectSlug} postId={post.id} ownerId={post.owner?.id ?? null} team={team.map((m) => ({ id: m.userId, name: m.user.name }))} />
            </Property>
            <Property label="ETA">
              <PostEtaSelect projectSlug={projectSlug} postId={post.id} eta={post.eta?.toISOString().slice(0, 7) ?? null} />
            </Property>
          </div>
          <div className="border-t pt-4">
            <PostVoters voters={voters} voteCount={post.voteCount} property={askingProperty} />
          </div>
          <div className="flex flex-col gap-2 border-t pt-4">
            <h3 className="font-medium">Reply</h3>
            {/* Keyed by post: J and K start each one's reply afresh. */}
            <CommentForm key={post.id} postId={post.id} placeholder="Reply as the team…" notes voters={toEmail} />
          </div>
        </>
      )}
    </section>
  );
}
