"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { keepingFields } from "@/lib/forms";
import { RichEditor } from "@/components/rich-editor";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { postPath } from "@/lib/post-urls";
import type { FormState } from "@/server/form-state";
import { createPost } from "@/server/posts";
import { findSimilarPosts, type SimilarPost } from "@/server/similar-posts";

const SUGGEST_DELAY_MS = 300;

export function NewPostForm({
  projectSlug,
  boardSlug,
  mediaBaseUrl,
  linkTarget,
  submit,
}: {
  projectSlug: string;
  boardSlug: string;
  /** Where uploaded images are served from; null when uploads are off. */
  mediaBaseUrl: string | null;
  /** "_blank" in the widget: suggested posts open on the portal, not in the panel. */
  linkTarget?: "_blank";
  /** Posts the form instead of the portal's createPost (the widget posts with its own sign-in). */
  submit?: (prev: FormState, formData: FormData) => Promise<FormState>;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  // Bumped after each post, to start the next one with an empty editor.
  const [submitted, setSubmitted] = useState(0);
  const [similar, setSimilar] = useState<SimilarPost[]>([]);
  const latestQuery = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await (submit ?? createPost)(prev, formData);
    if (!result.error) {
      formRef.current?.reset();
      setSubmitted((n) => n + 1);
      latestQuery.current++;
      setSimilar([]);
      toast.success("Feedback posted");
    }
    return result;
  }, {});

  useEffect(() => () => clearTimeout(timer.current), []);

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
    <Card>
      <CardContent>
        <form ref={formRef} onSubmit={keepingFields(action)}>
          <input type="hidden" name="projectSlug" value={projectSlug} />
          <input type="hidden" name="boardSlug" value={boardSlug} />
          <FieldGroup>
            <Field data-invalid={state.error ? true : undefined}>
              <FieldLabel htmlFor="post-title">Title</FieldLabel>
              <Input
                id="post-title"
                name="title"
                placeholder="Short, descriptive title"
                required
                autoComplete="off"
                onChange={(e) => suggest(e.target.value)}
                aria-invalid={state.error ? true : undefined}
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
                        href={postPath(post)}
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

            <Field>
              <FieldLabel id="post-body-label">Details</FieldLabel>
              <RichEditor
                key={submitted}
                profile="post"
                name="content"
                labelledBy="post-body-label"
                placeholder="Any more details?"
                uploads={mediaBaseUrl ? { projectSlug, mediaBaseUrl } : undefined}
              />
            </Field>
            <Button type="submit" disabled={pending} className="self-end">
              {pending ? "Posting…" : "Submit feedback"}
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
