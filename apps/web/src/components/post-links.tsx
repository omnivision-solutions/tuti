"use client";

import { CircleDotIcon, GitPullRequestIcon, type LucideIcon, TagIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { removePostLink } from "@/server/manage-posts";

export type PostLinkView = {
  id: string;
  kind: "PULL_REQUEST" | "ISSUE" | "RELEASE";
  repo: string;
  number: number | null;
  tag: string | null;
  url: string;
  title: string | null;
  /** The code change whose applied action added it. */
  codeChangeId: string | null;
};

const ICONS: Record<PostLinkView["kind"], LucideIcon> = {
  PULL_REQUEST: GitPullRequestIcon,
  ISSUE: CircleDotIcon,
  RELEASE: TagIcon,
};

/** The team's view of a post's GitHub links, each with remove. */
export function PostLinks({ projectSlug, postId, links }: { projectSlug: string; postId: string; links: PostLinkView[] }) {
  const [pending, startTransition] = useTransition();

  return (
    <section aria-label="GitHub links" className="flex flex-col gap-2">
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
              {link.codeChangeId && (
                <Link href={`/app/${projectSlug}/autopilot/${link.codeChangeId}`} className="shrink-0 text-xs text-muted-foreground hover:underline">
                  From Autopilot
                </Link>
              )}
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
    </section>
  );
}
