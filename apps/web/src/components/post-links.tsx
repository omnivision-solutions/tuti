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
      <ul className="flex flex-col gap-2 text-sm">
        {links.map((link) => {
          const Icon = ICONS[link.kind];
          const label = link.kind === "RELEASE" ? `${link.repo} ${link.tag}` : `${link.repo}#${link.number}`;
          return (
            // A bordered chip: what it is, where it came from, and unlinking it.
            <li key={link.id} className="flex items-center gap-2 rounded-lg border bg-card py-1.5 pr-1.5 pl-3">
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <a href={link.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 break-words hover:underline">
                <span className="font-medium">{label}</span>
                {link.title && <span className="text-muted-foreground max-sm:block max-sm:truncate"><span className="max-sm:hidden"> · </span>{link.title}</span>}
              </a>
              {link.codeChangeId && (
                <Link href={`/app/${projectSlug}/autopilot/activity/${link.codeChangeId}`} className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground">
                  From Autopilot
                </Link>
              )}
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${label}`}
                title="Unlink"
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
