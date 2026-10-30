"use client";

import type { MediaUrls } from "@tuti/content";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { keepingFields } from "@/lib/forms";
import { BARE_TITLE, RichEditor } from "@/components/rich-editor";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup } from "@/components/ui/field";
import { BOARD_TEXT_DEFAULTS } from "@/lib/board-texts";
import { postPath } from "@/lib/post-urls";
import type { FormState } from "@/server/form-state";
import { createPost } from "@/server/posts";
import { findSimilarPosts, type SimilarPost } from "@/server/similar-posts";
import { usePortalHref, usePortalPath } from "@/components/portal-base";

const SUGGEST_DELAY_MS = 300;

type Placeholders = { titlePlaceholder?: string; detailsPlaceholder?: string };

/**
 * "Share your idea" at the top of a board, for everyone: the title first, the details once it's
 * clicked or typed in. Signed out, the similar ideas show as they type, and "Sign in to post"
 * brings them back to the board with the title they typed.
 */
export function ShareIdeaBox({ signedIn, ...form }: { signedIn: boolean } & Omit<React.ComponentProps<typeof NewPostForm>, "collapsible" | "signedOut">) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Share your idea</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <NewPostForm {...form} collapsible signedOut={!signedIn} />
      </CardContent>
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
}: Placeholders & {
  projectSlug: string;
  boardSlug: string;
  /** Where uploaded images are served from; null when uploads are off. */
  mediaUrls: MediaUrls | null;
  /** "_blank" in the widget: suggested posts open on the portal, not in the panel. */
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
}) {
  const at = usePortalHref();
  const path = usePortalPath();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [expanded, setExpanded] = useState(!collapsible || !!defaultTitle);
  const [typed, setTyped] = useState(defaultTitle ?? "");
  const formRef = useRef<HTMLFormElement>(null);
  // Bumped after each post, to start the next one with an empty editor.
  const [submitted, setSubmitted] = useState(0);
  const [similar, setSimilar] = useState<SimilarPost[]>([]);
  const latestQuery = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Back to this page after signing in, its filters kept and the typed title in the box.
  const back = new URLSearchParams(searchParams);
  back.delete("title");
  if (typed.trim()) {
    back.set("title", typed.trim());
  }
  const signInHref = at(`/sign-in?${new URLSearchParams({ next: back.size ? `${path}?${back}` : path })}`);

  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await (submit ?? createPost)(prev, formData);
    if (!result.error) {
      formRef.current?.reset();
      setSubmitted((n) => n + 1);
      latestQuery.current++;
      setSimilar([]);
      toast.success("Feedback posted");
      onPosted?.();
    }
    return result;
  }, {});

  useEffect(() => () => clearTimeout(timer.current), []);

  // A prefilled title gets its similar posts too, once.
  const [initialTitle] = useState(defaultTitle);
  useEffect(() => {
    if (initialTitle && initialTitle.trim().length >= 3) {
      void findSimilarPosts(projectSlug, initialTitle).then((posts) => {
        if (latestQuery.current === 0) {
          setSimilar(posts);
        }
      });
    }
  }, [projectSlug, initialTitle]);

  // Look for similar posts once typing pauses; ignore replies to older queries.
  const suggest = (title: string) => {
    clearTimeout(timer.current);
    const query = ++latestQuery.current;
    if (title.trim().length < 3) {
      setSimilar([]);
      return;
    }
    timer.current = setTimeout(async () => {
      const posts = await findSimilarPosts(projectSlug, title);
      if (query === latestQuery.current) {
        setSimilar(posts);
      }
    }, SUGGEST_DELAY_MS);
  };

  return (
    <form
      ref={formRef}
      // Signed out, Enter in the title signs in too, rather than posting; before the page's script runs,
      // as a plain GET to sign-in that comes back to this board (the typed title is lost then).
      {...(signedOut
        ? {
            action: at("/sign-in"),
            method: "get",
            onSubmit: (event: React.FormEvent) => {
              event.preventDefault();
              router.push(signInHref);
            },
          }
        : keepingFields(action))}
    >
      {signedOut ? (
        <input type="hidden" name="next" value={path} />
      ) : (
        <>
          <input type="hidden" name="projectSlug" value={projectSlug} />
          <input type="hidden" name="boardSlug" value={boardSlug} />
        </>
      )}
      <FieldGroup>
        {/* No boxes: a title and the details, as they're published. */}
        <Field data-invalid={state.error ? true : undefined}>
          <input
            key={submitted}
            id="post-title"
            name="title"
            aria-label="Title"
            defaultValue={submitted === 0 ? initialTitle : undefined}
            placeholder={titlePlaceholder}
            required
            autoComplete="off"
            onFocus={() => setExpanded(true)}
            onChange={(e) => {
              setTyped(e.target.value);
              suggest(e.target.value);
            }}
            aria-invalid={state.error ? true : undefined}
            className={`${BARE_TITLE} text-xl`}
          />
          {state.error && <FieldError>{state.error}</FieldError>}
        </Field>

        {similar.length > 0 && (
          <div className="flex flex-col gap-1 rounded-lg border bg-muted/50 p-3" role="status">
            <p className="text-sm font-medium">Already posted? Vote on it instead:</p>
            <ul className="flex flex-col">
              {similar.map((post) => (
                <li key={post.id}>
                  <Link
                    href={at(postPath({ ...post, board: { slug: post.boardSlug } }))}
                    target={linkTarget}
                    className="flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted"
                  >
                    <span className="w-12 shrink-0 text-xs text-muted-foreground tabular-nums">
                      {post.voteCount} {post.voteCount === 1 ? "vote" : "votes"}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{post.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{post.boardName}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}

        {signedOut ? (
          <Link
            href={signInHref}
            className={buttonVariants({ className: "self-end" })}
          >
            Sign in to post
          </Link>
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
            <Button type="submit" disabled={pending} className="self-end">
              {pending ? "Posting…" : postButton}
            </Button>
          </>
        )}
      </FieldGroup>
    </form>
  );
}
