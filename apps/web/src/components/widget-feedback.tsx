"use client";

import type { MediaUrls } from "@tuti/content";
import { useEffect, useRef, useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { NewPostForm } from "@/components/new-post-form";
import { PostStatusBadge } from "@/components/post-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { VoteButton } from "@/components/vote-button";
import { latestOnly } from "@/lib/latest-only";
import { postPath } from "@/lib/post-urls";
import { WIDGET_IDENTIFY_MESSAGE, WIDGET_READY_MESSAGE } from "@/lib/widget-messages";
import { type WidgetIdea, widgetCreatePost, widgetIdeas, widgetSignIn, widgetSignOut, widgetVote } from "@/server/widget";

type SignedIn = { id: string; token: string; name: string; named: boolean; email: string | null };

type SignInResult = { signedIn: SignedIn } | { error: string } | { signedOut: true } | { pending: true } | { signingOut: true };

/** Every useWidgetSignIn on the page, told each token's result: one listener trades each token once, as each works only once. */
const subscribers = new Set<{ projectSlug: string; tell: (result: SignInResult) => void }>();

// One sign-in exchange at a time, the page's latest identity only: a slower one for someone before
// can't set its cookie or tell the panel after nobody, or someone else, is signed in.
const exchange = latestOnly();

function onIdentify(event: MessageEvent) {
  // Only from the page that embeds us; the token proves who it's for, whatever site that is.
  const data = event.data as { type?: unknown; token?: unknown } | null;
  const projectSlug = subscribers.values().next().value?.projectSlug;
  if (event.source !== window.parent || data?.type !== WIDGET_IDENTIFY_MESSAGE || !projectSlug) {
    return;
  }
  const tell = (result: SignInResult) => {
    for (const subscriber of subscribers) {
      subscriber.tell(result);
    }
  };
  // The page signs nobody in: whoever was is on their way out (Home stops showing them at once).
  if (data.token === null) {
    tell({ signingOut: true });
    // Signed out here even if clearing the cookie fails (it lasts until the browser closes or the token expires).
    exchange(() => widgetSignOut().catch(() => {}), () => tell({ signedOut: true }));
    return;
  }
  if (typeof data.token !== "string") {
    return;
  }
  // A token came: someone's signing in, however long trading it takes.
  tell({ pending: true });
  const token = data.token;
  exchange(
    // A failed exchange (the network, the server) signs nobody in, not whoever was before.
    () => widgetSignIn(projectSlug, token).catch(() => ({ error: "Couldn't sign you in" })),
    (result) => tell("error" in result ? { error: result.error } : { signedIn: result }),
  );
}

/**
 * Who the customer's page signs in to the widget (Tuti.identify): asks the page for a sign-in
 * token from the customer's app and trades it for a widget token (with `enabled`, so a page
 * that only might need it doesn't ask for a token it won't use).
 */
export function useWidgetSignIn(projectSlug: string, enabled = true) {
  const [signedIn, setSignedIn] = useState<SignedIn | null>(null);
  const [error, setError] = useState<string>();
  // Whether it's known who's here: the page answered (someone, or nobody), or didn't within 3 seconds
  // (a panel opened on its own, or a page with an older script, which only ever sends tokens).
  const [known, setKnown] = useState(false);
  // A token from the page is being traded.
  const [pending, setPending] = useState(false);
  // The page signed nobody in, and that's being done: whoever was signed in may not be any more.
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const subscriber = {
      projectSlug,
      tell: (result: SignInResult) => {
        // Someone's signing in: until it's traded (even after the 3 seconds), they may not be who's shown.
        if ("pending" in result) {
          clearTimeout(giveUp);
          setPending(true);
          return;
        }
        // Signing out: only Home, which hides whoever was, minds (a visitor's Messages carry on).
        if ("signingOut" in result) {
          setSigningOut(true);
          return;
        }
        setPending(false);
        setSigningOut(false);
        setKnown(true);
        // A token that doesn't check out: nobody's signed in, not whoever was before it.
        if ("error" in result) {
          setError(result.error);
          setSignedIn(null);
        } else if ("signedOut" in result) {
          setError(undefined);
          setSignedIn(null);
        } else {
          setError(undefined);
          setSignedIn(result.signedIn);
        }
      },
    };
    if (subscribers.size === 0) {
      window.addEventListener("message", onIdentify);
    }
    subscribers.add(subscriber);
    // Ready for a token (the page may have one; nothing secret in this message).
    window.parent.postMessage({ type: WIDGET_READY_MESSAGE }, "*");
    // Only if no token comes at all: once one has, it waits for its result.
    const giveUp = setTimeout(() => setKnown(true), 3000);
    return () => {
      clearTimeout(giveUp);
      subscribers.delete(subscriber);
      if (subscribers.size === 0) {
        window.removeEventListener("message", onIdentify);
      }
    };
  }, [projectSlug, enabled]);

  return { signedIn, error, known: !enabled || known, pending: enabled && pending, signingOut: enabled && signingOut };
}

/** Signing in on the portal in a new tab, coming back to `path` there (the panel's own sign-in is the customer's page's). */
const signInTo = (path: string) => `/sign-in?${new URLSearchParams({ next: path })}`;

/**
 * The widget's Feedback tab: "Suggest an idea" (the similar ideas as they type, to vote on instead),
 * then the trending ideas with their vote buttons, and Mine once someone's signed in. Reading needs no
 * one; voting and posting are the portal's signed-in user's (`portalSignedIn`, on the portal's own site)
 * or the person the customer's page signs in (useWidgetSignIn); otherwise they sign in on the portal in
 * a new tab, coming back to that idea, or to the board with the title they typed.
 */
export function WidgetFeedback({
  projectSlug,
  boardSlug,
  portalSignedIn,
  mediaUrls,
  ideas: initialIdeas,
  defaultTitle,
  ...texts
}: {
  projectSlug: string;
  boardSlug: string;
  portalSignedIn: boolean;
  /** For image uploads, which need the portal's sign-in. */
  mediaUrls: MediaUrls | null;
  /** The trending ideas, as whoever's here on the portal's own site (or nobody) sees them. */
  ideas: WidgetIdea[];
  defaultTitle?: string;
  postButton?: string;
  titlePlaceholder?: string;
  detailsPlaceholder?: string;
}) {
  const { signedIn, error, known, pending } = useWidgetSignIn(projectSlug, !portalSignedIn);
  const token = signedIn?.token ?? null;
  const viewer = portalSignedIn || !!signedIn;
  // Who votes here: what's known of their votes is theirs only.
  const identity = portalSignedIn ? "portal" : (signedIn?.id ?? null);
  const identityNow = useRef(identity);
  useEffect(() => {
    identityNow.current = identity;
  }, [identity]);
  const [mineAsked, setMineAsked] = useState(false);
  const mine = viewer && mineAsked;
  // The list shown and what it was asked for (whose, and whether Mine).
  const [list, setList] = useState<{ for: string; ideas: WidgetIdea[]; failed?: true }>({ for: `${null}:${false}`, ideas: initialIdeas });
  // Each idea's votes, and whether they voted, as the server last answered (a list, or a vote): every list
  // shows these. Server actions are sent one at a time, so the latest answer is the newest.
  const [votes, setVotes] = useState<{ identity: string | null; ideas: Record<string, { voteCount: number; voted: boolean }> }>({ identity, ideas: {} });
  const answered = (at: string | null, ideas: { id: string; voteCount: number; voted: boolean }[]) =>
    setVotes((before) =>
      // An answer for someone who's gone isn't kept; someone new starts with none.
      at !== identityNow.current
        ? before
        : { identity: at, ideas: { ...(before.identity === at ? before.ideas : {}), ...Object.fromEntries(ideas.map(({ id, voteCount, voted }) => [id, { voteCount, voted }])) } },
    );
  // Bumped after each post, to list it.
  const [posted, setPosted] = useState(0);
  const latest = useRef(0);
  const listed = useRef(`${null}:${false}:0`);

  // Again for whoever the page signs in (their votes), for Mine, and after posting; replies to older asks are ignored.
  useEffect(() => {
    const key = `${token}:${mine}:${posted}`;
    if (key === listed.current) {
      return;
    }
    listed.current = key;
    const ask = ++latest.current;
    const at = identity;
    widgetIdeas(projectSlug, token, mine).then(
      (found) => {
        if (ask === latest.current) {
          setList({ for: `${token}:${mine}`, ideas: found });
          answered(at, found);
        }
      },
      () => ask === latest.current && setList({ for: `${token}:${mine}`, ideas: [], failed: true }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `identity` changes with `token`; `answered` only sets state.
  }, [projectSlug, token, mine, posted]);
  // Until the list asked for comes, or while someone's being signed in, nobody's list (or votes) shows.
  const loading = pending || list.for !== `${token}:${mine}`;

  const voteFor = (post: { id: string; number: number; title: string; board: { slug: string }; voteCount: number; voted: boolean }) => {
    const shown = (votes.identity === identity && votes.ideas[post.id]) || post;
    return (
      <VoteButton
        postId={post.id}
        count={shown.voteCount}
        voted={shown.voted}
        disabled={!known || pending}
        vote={async (voted) => {
          const at = identity;
          const result = await widgetVote(projectSlug, token, post.id, voted);
          if (result.votes !== undefined) {
            answered(at, [{ id: post.id, voteCount: result.votes, voted }]);
          }
          return result;
        }}
        signInHref={known && !viewer ? signInTo(postPath(post)) : undefined}
      />
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Suggest an idea</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {signedIn && <p className="text-sm text-muted-foreground">Posting as {signedIn.name}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <NewPostForm
            projectSlug={projectSlug}
            boardSlug={boardSlug}
            mediaUrls={portalSignedIn ? mediaUrls : null}
            linkTarget="_blank"
            collapsible
            signedOut={!viewer}
            submit={token ? (prev, formData) => widgetCreatePost(projectSlug, token, prev, formData) : undefined}
            onPosted={() => setPosted((n) => n + 1)}
            similarVote={(post) => voteFor({ ...post, board: { slug: post.boardSlug } })}
            widgetToken={token}
            defaultTitle={defaultTitle}
            {...texts}
          />
        </CardContent>
      </Card>

      <section aria-label="Ideas" aria-busy={loading} className="flex flex-col gap-3">
        {!viewer && <h2 className="px-1 text-sm font-medium">Trending</h2>}
        {viewer && (
          <div role="group" aria-label="Show" className="flex gap-1">
            {(
              [
                ["Trending", false],
                ["Mine", true],
              ] as const
            ).map(([name, value]) => (
              <Button key={name} size="sm" variant={mine === value ? "secondary" : "ghost"} aria-pressed={mine === value} onClick={() => setMineAsked(value)}>
                {name}
              </Button>
            ))}
          </div>
        )}
        {loading ? (
          <div className="flex flex-col gap-3 rounded-xl border bg-card p-3">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-3">
                <Skeleton className="h-12 w-12" />
                <Skeleton className="h-4 flex-1" />
              </div>
            ))}
          </div>
        ) : list.ideas.length > 0 ? (
          <ul className="flex flex-col divide-y rounded-xl border bg-card px-3">
            {list.ideas.map((idea) => (
              <li key={idea.id} className="flex items-center gap-3 py-3">
                {voteFor(idea)}
                <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                  {mine && <PostStatusBadge status={idea.status} />}
                  <a href={postPath(idea)} target="_blank" rel="noreferrer" className="font-medium break-words hover:underline">
                    {idea.title}
                  </a>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title={list.failed ? "Couldn't load the ideas" : mine ? "Nothing of yours yet" : "No ideas yet"}
            description={list.failed ? "Try again in a moment." : mine ? "Ideas you suggest or vote for show up here." : "Be the first to suggest one."}
          />
        )}
      </section>
    </div>
  );
}
