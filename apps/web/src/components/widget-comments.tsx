"use client";

import type { Doc } from "@tuti/content";
import type { MediaUrls } from "@tuti/content/media";
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

/**
 * What a save answers while the page trades a token: without one the server would act for the portal's session, which may
 * be someone else's. Nothing's sent; what's typed stays, to send once they're signed in.
 */
const SIGNING_IN = { error: "Signing you in… Try again in a moment." };

const Commenter = createContext<{
  projectSlug: string;
  number: number;
  token: string | null;
  person: string | null;
  /** The portal's signed-in reader, whose actions take no token. */
  portal?: boolean;
  mine: Set<string>;
  uploads?: EditorUploads;
  mediaUrls?: MediaUrls | null;
}>({ projectSlug: "", number: 0, token: null, person: null, mine: NONE });

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
  mediaUrls,
  children,
}: {
  projectSlug: string;
  number: number;
  entryId: string;
  portalSignedIn: boolean;
  portalMine: string[];
  /** Images, for the portal's signed-in reader (uploads need its session). */
  uploads?: EditorUploads;
  /** The comments' images' signed URLs, for their editors without uploads. */
  mediaUrls?: MediaUrls | null;
  children: React.ReactNode;
}) {
  const { signedIn, known, pending, signingOut } = useWidgetSignIn(projectSlug, !portalSignedIn);
  const link = usePortalHref();
  // While the page switches people or signs them out, nobody: never the last person's token.
  const token = pending || signingOut ? null : (signedIn?.token ?? null);
  // Who's here: the same person while the page trades a token (each trade makes a new one, for them or someone else), so
  // their box, an open edit or Delete's dialog stay, waiting (no token: nothing's sent, see SIGNING_IN). Signing out, they're
  // leaving: nobody's box, and their open edits close.
  const person = portalSignedIn ? "portal" : signingOut ? null : (signedIn?.id ?? null);
  // Whose own comments these are; anyone else's are none until theirs are read, never the last person's.
  const [mine, setMine] = useState<{ for: string | null; ids: Set<string> }>({ for: null, ids: NONE });
  const read = !portalSignedIn && !!person && mine.for === person;
  const own = portalSignedIn ? new Set(portalMine) : read ? mine.ids : NONE;

  useEffect(() => {
    if (!token || !person) {
      return;
    }
    let current = true;
    widgetComments(projectSlug, token, number).then(
      (result) => current && setMine({ for: person, ids: new Set(result.comments?.filter((c) => c.mine).map((c) => c.id)) }),
      // Unread, none are theirs to edit: they can still comment.
      () => current && setMine({ for: person, ids: NONE }),
    );
    return () => {
      current = false;
    };
  }, [projectSlug, token, person, number]);

  const box = portalSignedIn ? (
    <CommentForm postId={`${entryId}:portal`} action={widgetComment.bind(null, projectSlug, null, number)} signedIn uploads={uploads} />
  ) : read ? (
    <CommentForm
      // Theirs: one person's draft is never another's box.
      key={person}
      postId={`${entryId}:${person}`}
      waiting={!token}
      action={async (prev, formData) => {
        if (!token) {
          return SIGNING_IN;
        }
        const result = await widgetComment(projectSlug, token, number, prev, formData);
        const id = result.id;
        if (id) {
          // Only while they're still who's here: a comment saved after the page switched people is nobody else's.
          startTransition(() => setMine((m) => (m.for !== person ? m : { for: person, ids: new Set([...m.ids, id]) })));
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
    <Commenter value={{ projectSlug, number, token, person, portal: portalSignedIn, mine: own, uploads, mediaUrls }}>
      {read && !token && <p className="text-sm text-muted-foreground">Signing you in…</p>}
      {box}
      {children}
    </Commenter>
  );
}

/** A comment's text in the widget, with Edit and Delete when it's its person's own (WidgetComments). */
export function WidgetComment({ commentId, author, doc, children }: { commentId: string; author: string; doc: Doc; children: React.ReactNode }) {
  const { projectSlug, number, token, person, portal, mine, uploads, mediaUrls } = use(Commenter);
  // Someone the page signs in acts only with their token: never the portal session's fallback (SIGNING_IN).
  const signingIn = !portal && !token;
  const theirs = mine.has(commentId);
  return (
    <ChangelogComment
      // Remounted per person (not per token: the same person's fresh one keeps their edit open): one's edit or delete left
      // open is never another's.
      key={person ?? "nobody"}
      projectSlug={projectSlug}
      number={number}
      commentId={commentId}
      author={author}
      doc={doc}
      canEdit={theirs}
      canDelete={theirs}
      uploads={uploads}
      mediaUrls={mediaUrls}
      onEdit={async (prev, formData) => (signingIn ? SIGNING_IN : widgetEditComment(projectSlug, token, number, commentId, prev, formData))}
      onDelete={async () => (signingIn ? SIGNING_IN : widgetDeleteComment(projectSlug, token, number, commentId))}
    >
      {children}
    </ChangelogComment>
  );
}
