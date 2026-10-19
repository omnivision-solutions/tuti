"use client";

import { CircleDotIcon, GitPullRequestIcon, type LucideIcon, TagIcon, XIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addPostLink, removePostLink } from "@/server/manage-posts";

export type PostLinkView = {
  id: string;
  kind: "PULL_REQUEST" | "ISSUE" | "RELEASE";
  repo: string;
  number: number | null;
  tag: string | null;
  url: string;
  title: string | null;
};

const ICONS: Record<PostLinkView["kind"], LucideIcon> = {
  PULL_REQUEST: GitPullRequestIcon,
  ISSUE: CircleDotIcon,
  RELEASE: TagIcon,
};

/** The team's view of a post's GitHub links, with "Link" and remove. */
export function PostLinks({ projectSlug, postId, links }: { projectSlug: string; postId: string; links: PostLinkView[] }) {
  const [pending, startTransition] = useTransition();
  const [url, setUrl] = useState("");

  return (
    <section aria-label="GitHub links" className="flex flex-col gap-2">
      {links.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {links.map((link) => {
            const Icon = ICONS[link.kind];
            const label = link.kind === "RELEASE" ? `${link.repo} ${link.tag}` : `${link.repo}#${link.number}`;
            return (
              <li key={link.id} className="flex items-center gap-2">
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <a href={link.url} target="_blank" rel="noopener noreferrer" className="min-w-0 break-all hover:underline">
                  {label}
                  {link.title && <span className="text-muted-foreground"> · {link.title}</span>}
                </a>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${label}`}
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const result = await removePostLink(projectSlug, postId, link.id);
                      if (result.error) {
                        toast.error(result.error);
                      }
                    })
                  }
                >
                  <XIcon />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          startTransition(async () => {
            const result = await addPostLink(projectSlug, postId, url);
            if (result.error) {
              toast.error(result.error);
              return;
            }
            setUrl("");
            toast.success("Linked");
          });
        }}
      >
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          required
          placeholder="https://github.com/owner/repo/pull/123"
          aria-label="GitHub pull request, issue or release URL"
          className="min-w-0 flex-1 sm:max-w-md"
        />
        <Button type="submit" variant="outline" disabled={pending}>
          Link
        </Button>
      </form>
    </section>
  );
}
