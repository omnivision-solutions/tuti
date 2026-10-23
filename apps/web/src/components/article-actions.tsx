"use client";

import { ChevronDownIcon, CopyIcon, ExternalLinkIcon, FileTextIcon } from "lucide-react";
import { toast } from "sonner";

import { usePortalLook } from "@/components/portal-look";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/**
 * Reader actions on a docs article, as the team picked them (Customize → Content actions): "Copy
 * page" copies it as Markdown, and its menu takes it to an AI tool or opens its Markdown.
 */
export function ArticleActions({ markdown, markdownUrl }: { markdown: string; markdownUrl: string }) {
  const { contentActions } = usePortalLook();
  if (!contentActions.menu) {
    return null;
  }
  const prompt = encodeURIComponent(`Read ${markdownUrl} and answer questions about it.`);
  const open = (name: string, href: string) => (
    <DropdownMenuItem render={<a href={href} target="_blank" rel="noopener noreferrer" />}>
      <ExternalLinkIcon />
      Open in {name}
    </DropdownMenuItem>
  );
  return (
    <div className="flex shrink-0 items-center rounded-lg border">
      {contentActions.copyMarkdown && (
        <Button
          variant="ghost"
          size="sm"
          className="rounded-r-none border-r"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(markdown);
              toast.success("Copied as Markdown");
            } catch {
              toast.error("Couldn't copy it. Your browser may not allow it here.");
            }
          }}
        >
          <CopyIcon />
          Copy page
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size={contentActions.copyMarkdown ? "icon-sm" : "sm"} className={contentActions.copyMarkdown ? "rounded-l-none" : undefined} />}
          aria-label={contentActions.copyMarkdown ? "More page actions" : undefined}
        >
          {!contentActions.copyMarkdown && "Page actions"}
          <ChevronDownIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-max">
          {contentActions.chatGpt && open("ChatGPT", `https://chatgpt.com/?q=${prompt}`)}
          {contentActions.claude && open("Claude", `https://claude.ai/new?q=${prompt}`)}
          <DropdownMenuItem render={<a href={markdownUrl} target="_blank" rel="noopener noreferrer" />}>
            <FileTextIcon />
            View as Markdown
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** "Updated …" under an article's title, unless the team turned it off (Customize → Content actions). */
export function ArticleUpdated({ at, label }: { at: string; label: string }) {
  if (!usePortalLook().contentActions.updatedDate) {
    return null;
  }
  return (
    <p className="text-sm text-muted-foreground">
      Updated <time dateTime={at}>{label}</time>
    </p>
  );
}
