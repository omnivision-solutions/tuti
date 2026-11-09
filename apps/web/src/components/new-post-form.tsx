"use client";

import type { MediaUrls } from "@tuti/content";
import { LightbulbIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useActionState, useEffect, useEffectEvent, useRef, useState } from "react";
import { toast } from "sonner";

import { keepingFields } from "@/lib/forms";
import { BARE_TITLE, RichEditor } from "@/components/rich-editor";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldGroup } from "@/components/ui/field";
import { BOARD_TEXT_DEFAULTS } from "@/lib/board-texts";
import { boardPath, postPath } from "@/lib/post-urls";
import type { FormState } from "@/server/form-state";
import { createPost } from "@/server/posts";
import { findSimilarPosts, type SimilarPost } from "@/server/similar-posts";
import { usePortalHref, usePortalPath } from "@/components/portal-base";
import { Card } from "@/components/ui/card";

const SUGGEST_DELAY_MS = 300;

type Placeholders = { titlePlaceholder?: string; detailsPlaceholder?: string };

/**
 * "Share an idea" at the top of a board, for everyone: the title first, the details once it's
 * clicked or typed in. Signed out, the similar ideas show as they type, and "Sign in to post"
 * brings them back to the board with the title they typed.
 */
export function ShareIdeaBox({ signedIn, ...form }: { signedIn: boolean } & Omit<React.ComponentProps<typeof NewPostForm>, "collapsible" | "signedOut">) {
  return (
    <Card role="region" aria-labelledby="share-idea" className="gap-2 px-5">
      {/* What the box is for, then the box: its title first, the details once it's opened. */}
      <h2 id="share-idea" className="flex items-center gap-2 font-semibold">
        <LightbulbIcon aria-hidden className="size-4 text-soft-foreground" />
        Share an idea
      </h2>
      <NewPostForm {...form} collapsible signedOut={!signedIn} />
    </Card>
  );
}

/** A post's title and details, with the similar posts already there as the title is typed. */
export function NewPostForm({
  projectSlug,
  boardSlug,
  mediaUrls,
  linkTarget,
  submit,
  defaultTitle,
  titlePlaceholder = BOARD_TEXT_DEFAULTS.titlePlaceholder,
  detailsPlaceholder = BOARD_TEXT_DEFAULTS.detailsPlaceholder,
  postButton = BOARD_TEXT_DEFAULTS.postButton,
  collapsible = false,
  signedOut = false,
  onPosted,
  similarVote,
  widgetToken,
  onSimilar,
}: Placeholders & {
  projectSlug: string;
  boardSlug: string;
  /** Where uploaded images are served from; null when uploads are off. */
  mediaUrls: MediaUrls | null;
  /** "_blank" in the widget: suggested posts open on the portal, not in the panel, and so does signing in (coming back to the board). */
  linkTarget?: "_blank";
  /** Posts the form instead of the portal's createPost (the widget posts with its own sign-in). */
  submit?: (prev: FormState, formData: FormData) => Promise<FormState>;
  /** A title to start the first post with (the question from the docs' "Post this as feedback"). */
  defaultTitle?: string;
  /** The submit button's words (the board's own). */
  postButton?: string;
  /** Just the title until it's clicked or typed in (a board's box). */
  collapsible?: boolean;
  /** No details or posting: "Sign in to post" instead, coming back with the title. */
  signedOut?: boolean;
  /** After each post. */
  onPosted?: () => void;
  /** A vote button for each similar post, in place of its count (the widget's). */
  similarVote?: (post: SimilarPost) => React.ReactNode;
  /** Who the widget's signed in (its token), for whether they voted for the similar posts. */
  widgetToken?: string | null;
  /** Each answer of similar posts (the widget keeps their votes with its lists'). */
  onSimilar?: (posts: SimilarPost[]) => void;
}) {
  const at = usePortalHref();
  const path = usePortalPath();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [expanded, setExpanded] = useState(!collapsible || !!defaultTitle);
  const formRef = useRef<HTMLFormElement>(null);
  // Bumped after each post, to start the next one with an empty editor.
  const [submitted, setSubmitted] = useState(0);
  const [similar, setSimilar] = useState<SimilarPost[]>([]);
  const latestQuery = useRef(0);
  // The title last looked for (prefilled, or typed).
  const searched = useRef(defaultTitle ?? "");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Back to this page after signing in, its filters kept and the title in the box (read when it's sent,
  // so one typed before the page's script ran counts too; without the script, sign-in adds it). From
  // the widget, to the board on the portal, in a new tab: the panel's own sign-in is the customer's page's.
  const withoutTitle = new URLSearchParams(searchParams);
  withoutTitle.delete("title");
  const returnTo = linkTarget ? boardPath({ slug: boardSlug }) : withoutTitle.size ? `${path}?${withoutTitle}` : path;
  const signInFor = (title: string) => {
    const back = new URLSearchParams(withoutTitle);
    if (title) {
      back.set("title", title);
    }
    return at(`/sign-in?${new URLSearchParams({ next: back.size ? `${path}?${back}` : path })}`);
  };

  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await (submit ?? createPost)(prev, formData);
    if (!result.error) {
      formRef.current?.reset();
      setSubmitted((n) => n + 1);
      searched.current = "";
      latestQuery.current++;
      setSimilar([]);
      toast.success("Feedback posted");
      onPosted?.();
    }
    return result;
  }, {});

  useEffect(() => () => clearTimeout(timer.current), []);

  const [initialTitle] = useState(defaultTitle);
  const found = useEffectEvent((posts: SimilarPost[]) => {
    setSimilar(posts);
    onSimilar?.(posts);
  });

  // A prefilled title gets its similar posts too; and the one in the box, again, for whoever the widget
  // signs in (whether they voted for each); replies for before are ignored.
  useEffect(() => {
    const title = searched.current;
    if (title.trim().length < 3) {
      return;
    }
    clearTimeout(timer.current);
    const query = ++latestQuery.current;
    void findSimilarPosts(projectSlug, title, widgetToken).then((posts) => {
      if (query === latestQuery.current) {
        found(posts);
      }
    });
  }, [projectSlug, widgetToken]);

  // Look for similar posts once typing pauses; ignore replies to older queries.
  const suggest = (title: string) => {
    clearTimeout(timer.current);
    searched.current = title;
    const query = ++latestQuery.current;
    if (title.trim().length < 3) {
      setSimilar([]);
      return;
    }
    timer.current = setTimeout(async () => {
      const posts = await findSimilarPosts(projectSlug, title, widgetToken);
      if (query === latestQuery.current) {
        setSimilar(posts);
        onSimilar?.(posts);
      }
    }, SUGGEST_DELAY_MS);
  };

  // A board's box before it's opened (and always signed out): the title and its button on one line.
  const oneLine = collapsible && (signedOut || !expanded);
  return (
    <form
      ref={formRef}
      data-expanded={collapsible && !oneLine ? true : undefined}
      // Signed out, sending it (Enter, or "Sign in to post") signs in rather than posting; before the page's
      // script runs, as a plain GET to sign-in, which brings the title back to this board.
      {...(signedOut
        ? {
            action: at("/sign-in"),
            method: "get",
            target: linkTarget,
            onSubmit: (event: React.FormEvent<HTMLFormElement>) => {
              if (linkTarget) {
                return;
              }
              event.preventDefault();
              router.push(signInFor(String(new FormData(event.currentTarget).get("title") ?? "").trim()));
            },
          }
        : keepingFields(action))}
    >
      {signedOut ? (
        <input type="hidden" name="next" value={returnTo} />
      ) : (
        <>
          <input type="hidden" name="projectSlug" value={projectSlug} />
          <input type="hidden" name="boardSlug" value={boardSlug} />
        </>
      )}
      <FieldGroup className={cn(oneLine && "flex-row flex-wrap items-center gap-2")}>
        {/* No boxes: a title and the details, as they're published. */}
        <Field data-invalid={state.error ? true : undefined} className={cn(oneLine && "w-auto min-w-0 flex-1 basis-24")}>
          {/* One element throughout (swapping it as the box opens would lose the focus and what's typed): the design
              system's field on one line; opened (and the widget's), a title with no box, set as it's published. */}
          <Input
            key={submitted}
            id="post-title"
            name="title"
            aria-label="Title"
            defaultValue={submitted === 0 ? initialTitle : undefined}
            placeholder={titlePlaceholder}
            required
            autoComplete="off"
            onFocus={() => setExpanded(true)}
            onChange={(e) => suggest(e.target.value)}
            aria-invalid={state.error ? true : undefined}
            className={
              oneLine
                ? "h-10 text-base md:text-base"
                : cn(
                    "h-auto rounded-none border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-0 dark:bg-transparent",
                    BARE_TITLE,
                    collapsible ? "text-lg md:text-lg" : "text-xl md:text-xl",
                  )
            }
          />
          {state.error && <FieldError>{state.error}</FieldError>}
        </Field>

        {similar.length > 0 && (
          <div className={cn("flex flex-col gap-1 rounded-lg border bg-muted/50 p-3", oneLine && "order-last basis-full")} role="status">
            <p className="text-sm font-medium">Already posted? Vote on it instead:</p>
            <ul className="flex flex-col">
              {similar.map((post) => (
                <li key={post.id} className="flex items-center gap-2">
                  {similarVote?.(post)}
                  <Link
                    href={at(postPath({ ...post, board: { slug: post.boardSlug } }))}
                    target={linkTarget}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted"
                  >
                    {!similarVote && (
                      <span className="w-12 shrink-0 text-xs text-muted-foreground tabular-nums">
                        {post.voteCount} {post.voteCount === 1 ? "vote" : "votes"}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate">{post.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{post.boardName}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {signedOut ? (
          // Submits the form (its sign-in GET, or the push above), so a title typed before the script ran goes too;
          // an empty title may sign in as well.
          <Button type="submit" formNoValidate className={cn(!oneLine && "self-end")}>
            Sign in to post
          </Button>
        ) : (
          <>
            {expanded && (
              <RichEditor
                key={submitted}
                bare
                profile="post"
                name="content"
                label="Details"
                placeholder={detailsPlaceholder}
                uploads={mediaUrls ? { projectSlug, mediaUrls } : undefined}
              />
            )}
            <Button type="submit" disabled={pending} className={cn(!oneLine && "self-end")}>
              {pending ? "Posting…" : postButton}
            </Button>
          </>
        )}
      </FieldGroup>
    </form>
  );
}
