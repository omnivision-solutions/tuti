"use client";

import type { Doc } from "@tuti/content";
import { MessageCircleIcon } from "lucide-react";
import { createContext, startTransition, use, useEffect, useState } from "react";

import { ChangelogComment } from "@/components/changelog-comment";
import { CommentForm } from "@/components/comment-form";
import { usePortalHref } from "@/components/portal-base";
import type { EditorUploads } from "@/components/rich-editor";
import { buttonVariants } from "@/components/ui/button";
import { signInTo, useWidgetSignIn } from "@/components/widget-feedback";
import { widgetComment, widgetComments, widgetDeleteComment, widgetEditComment } from "@/server/widget";

const NONE = new Set<string>();

const Commenter = createContext<{ projectSlug: string; number: number; token: string | null; mine: Set<string>; uploads?: EditorUploads }>({
  projectSlug: "",
  number: 0,
  token: null,
  mine: NONE,
});

/**
 * An entry's comments in the widget's panel (`children`: the list the page rendered, each comment's text in a
 * WidgetComment), with the box above them: for the portal's signed-in reader on its own site (whose own comments the page
 * knows, `portalMine`), else for whoever the customer's page signs in (Tuti.identify), whose own are asked for once their
 * token is in; signed out, the way to sign in on the portal, as Feedback's votes.
 */
export function WidgetComments({
  projectSlug,
  number,
  entryId,
  portalSignedIn,
  portalMine,
  uploads,
  children,
}: {
  projectSlug: string;
  number: number;
  entryId: string;
  portalSignedIn: boolean;
  portalMine: string[];
  /** Images, for the portal's signed-in reader (uploads need its session). */
  uploads?: EditorUploads;
  children: React.ReactNode;
}) {
  const { signedIn, known, pending, signingOut } = useWidgetSignIn(projectSlug, !portalSignedIn);
  const link = usePortalHref();
  // While the page switches people or signs them out, nobody: never the last person's token.
  const token = pending || signingOut ? null : (signedIn?.token ?? null);
  // Whose own comments these are; anyone else's are none until theirs are read, never the last person's.
  const [mine, setMine] = useState<{ for: string | null; ids: Set<string> }>({ for: null, ids: NONE });
  const read = !!token && mine.for === token;
  const own = portalSignedIn ? new Set(portalMine) : read ? mine.ids : NONE;

  useEffect(() => {
    if (!token) {
      return;
    }
    let current = true;
    widgetComments(projectSlug, token, number).then(
      (result) => current && setMine({ for: token, ids: new Set(result.comments?.filter((c) => c.mine).map((c) => c.id)) }),
      // Unread, none are theirs to edit: they can still comment.
      () => current && setMine({ for: token, ids: NONE }),
    );
    return () => {
      current = false;
    };
  }, [projectSlug, token, number]);

  const box = portalSignedIn ? (
    <CommentForm postId={`${entryId}:portal`} action={widgetComment.bind(null, projectSlug, null, number)} signedIn uploads={uploads} />
  ) : read ? (
    <CommentForm
      // Theirs: one person's draft is never another's box.
      key={token}
      postId={`${entryId}:${signedIn!.id}`}
      action={async (prev, formData) => {
        const result = await widgetComment(projectSlug, token, number, prev, formData);
        const id = result.id;
        if (id) {
          // Only while they're still who's here: a comment saved after the page switched people is nobody else's.
          startTransition(() => setMine((m) => (m.for !== token ? m : { for: token, ids: new Set([...m.ids, id]) })));
        }
        return result;
      }}
      signedIn
    />
  ) : (
    known &&
    !pending &&
    !signingOut &&
    !signedIn && (
      <div className="flex items-center gap-3 rounded-xl bg-muted p-4">
        <MessageCircleIcon aria-hidden className="size-[1.125rem] shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">Sign in to comment.</p>
        <a
          href={link(signInTo(`/changelog/${number}`))}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: "outline", className: "font-semibold portal:bg-card portal:hover:bg-card/70" })}
        >
          Sign in
        </a>
      </div>
    )
  );

  return (
    <Commenter value={{ projectSlug, number, token, mine: own, uploads }}>
      {box}
      {children}
    </Commenter>
  );
}

/** A comment's text in the widget, with Edit and Delete when it's its person's own (WidgetComments). */
export function WidgetComment({ commentId, author, doc, children }: { commentId: string; author: string; doc: Doc; children: React.ReactNode }) {
  const { projectSlug, number, token, mine, uploads } = use(Commenter);
  const theirs = mine.has(commentId);
  return (
    <ChangelogComment
      // Remounted per person: one's edit or delete left open is never another's.
      key={token ?? "portal"}
      projectSlug={projectSlug}
      number={number}
      commentId={commentId}
      author={author}
      doc={doc}
      canEdit={theirs}
      canDelete={theirs}
      uploads={uploads}
      onEdit={(prev, formData) => widgetEditComment(projectSlug, token, number, commentId, prev, formData)}
      onDelete={() => widgetDeleteComment(projectSlug, token, number, commentId)}
    >
      {children}
    </ChangelogComment>
  );
}
