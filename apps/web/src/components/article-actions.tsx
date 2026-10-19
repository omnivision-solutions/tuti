"use client";

import { CopyIcon, ExternalLinkIcon } from "lucide-react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";

const quiet = "text-muted-foreground";

/** Reader actions under a help article: take it to an AI tool as Markdown. */
export function ArticleActions({ markdown, markdownUrl }: { markdown: string; markdownUrl: string }) {
  const prompt = encodeURIComponent(`Read ${markdownUrl} and answer questions about it.`);
  const open = (name: string, href: string) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "ghost", size: "sm", className: quiet })}>
      <ExternalLinkIcon />
      Open in {name}
    </a>
  );
  return (
    <div className="-mx-2.5 flex flex-wrap gap-1">
      <Button
        variant="ghost"
        size="sm"
        className={quiet}
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
        Copy as Markdown
      </Button>
      {open("ChatGPT", `https://chatgpt.com/?q=${prompt}`)}
      {open("Claude", `https://claude.ai/new?q=${prompt}`)}
    </div>
  );
}
