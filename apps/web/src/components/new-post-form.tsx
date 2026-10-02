"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { postPath } from "@/lib/post-urls";
import type { FormState } from "@/server/form-state";
import { createPost } from "@/server/posts";
import { findSimilarPosts, type SimilarPost } from "@/server/similar-posts";

const SUGGEST_DELAY_MS = 300;

export function NewPostForm({ projectSlug, boardSlug }: { projectSlug: string; boardSlug: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [similar, setSimilar] = useState<SimilarPost[]>([]);
  const latestQuery = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await createPost(prev, formData);
    if (!result.error) {
      formRef.current?.reset();
      latestQuery.current++;
      setSimilar([]);
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
        <form ref={formRef} action={action}>
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
              <FieldLabel htmlFor="post-body">Details</FieldLabel>
              <Textarea id="post-body" name="body" placeholder="Any more details?" rows={3} />
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
