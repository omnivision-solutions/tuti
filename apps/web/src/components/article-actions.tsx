"use client";

import { ChevronDownIcon, CopyIcon, ExternalLinkIcon, FileTextIcon, Clock3Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { usePortalLook } from "@/components/portal-look";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/**
 * Reader actions on a docs article, as the team picked them (Customize → Content actions): "Copy
 * page" copies it as Markdown, and its menu takes it to an AI tool or opens its Markdown.
 */
export function ArticleActions({ markdown, markdownUrl }: { markdown: string; markdownUrl: string }) {
  const { contentActions } = usePortalLook();
  const t = useTranslations("docs");
  if (!contentActions.menu) {
    return null;
  }
  const prompt = encodeURIComponent(t("aiPrompt", { url: markdownUrl }));
  const open = (name: string, href: string) => (
    <DropdownMenuItem render={<a href={href} target="_blank" rel="noopener noreferrer" />}>
      <ExternalLinkIcon />
      {t("openIn", { name })}
    </DropdownMenuItem>
  );
  return (
    // Its own width: under the title on phones, it would otherwise stretch across the page. On the portal a grey fill, as secondaries are.
    <div className="flex shrink-0 items-center self-start rounded-lg border portal:border-0 portal:bg-secondary">
      {contentActions.copyMarkdown && (
        <Button
          variant="ghost"
          size="sm"
          className="rounded-r-none border-r portal:border-background portal:hover:bg-secondary-hover"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(markdown);
              toast.success(t("copiedMarkdown"));
            } catch {
              toast.error(t("couldntCopy"));
            }
          }}
        >
          <CopyIcon />
          {t("copyPage")}
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size={contentActions.copyMarkdown ? "icon-sm" : "sm"} className={cn("portal:hover:bg-secondary-hover", contentActions.copyMarkdown && "rounded-l-none")} />}
          aria-label={contentActions.copyMarkdown ? t("morePageActions") : undefined}
        >
          {!contentActions.copyMarkdown && t("pageActions")}
          <ChevronDownIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-max">
          {contentActions.chatGpt && open("ChatGPT", `https://chatgpt.com/?q=${prompt}`)}
          {contentActions.claude && open("Claude", `https://claude.ai/new?q=${prompt}`)}
          <DropdownMenuItem render={<a href={markdownUrl} target="_blank" rel="noopener noreferrer" />}>
            <FileTextIcon />
            {t("viewMarkdown")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** "Updated …" under an article's title, unless the team turned it off (Customize → Content actions). */
export function ArticleUpdated({ at, label }: { at: string; label: string }) {
  const t = useTranslations("docs");
  if (!usePortalLook().contentActions.updatedDate) {
    return null;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Clock3Icon aria-hidden className="size-3.5" />
      {t.rich("updated", { date: label, time: (chunks) => <time dateTime={at}>{chunks}</time> })}
    </span>
  );
}
