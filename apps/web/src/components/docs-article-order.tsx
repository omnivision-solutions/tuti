"use client";

import { type DragEvent, type ReactNode, useState, useTransition } from "react";
import { toast } from "sonner";
import { moveArticle } from "@/server/docs";

/** The collection and tree use the same saved reading order. Keyboard moves remain in the tree's row menus. */
export function DocsArticleOrder({
  projectSlug,
  collection,
  articles,
  children,
}: {
  projectSlug: string;
  collection: string;
  articles: string[];
  children: ReactNode;
}) {
  const [moving, setMoving] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const row = (event: DragEvent) =>
    (event.target as Element).closest<HTMLElement>("[data-article-slug]");
  return (
    <ul
      aria-busy={pending}
      className="flex flex-col divide-y px-1 [&_[data-article-slug]]:cursor-grab [&_[data-article-slug]]:rounded-md"
      onDragStart={(event) => {
        const slug = row(event)?.dataset.articleSlug;
        if (pending || !slug) {
          event.preventDefault();
          return;
        }
        setMoving(slug);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", slug);
      }}
      onDragOver={(event) => {
        const slug = row(event)?.dataset.articleSlug;
        if (!moving || !slug) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (over !== slug) {
          event.currentTarget
            .querySelectorAll("[data-drop-target]")
            .forEach((element) => element.removeAttribute("data-drop-target"));
          row(event)?.setAttribute("data-drop-target", "");
          setOver(slug);
        }
      }}
      onDragEnd={(event) => {
        setMoving(null);
        setOver(null);
        event.currentTarget
          .querySelectorAll("[data-drop-target]")
          .forEach((element) => element.removeAttribute("data-drop-target"));
      }}
      onDrop={(event) => {
        const slug = row(event)?.dataset.articleSlug;
        event.currentTarget
          .querySelectorAll("[data-drop-target]")
          .forEach((element) => element.removeAttribute("data-drop-target"));
        event.preventDefault();
        setMoving(null);
        setOver(null);
        if (!moving || !slug || moving === slug) return;
        start(async () => {
          const result = await moveArticle(
            projectSlug,
            moving,
            collection,
            articles.indexOf(slug),
          );
          if (result.error) toast.error(result.error);
          else toast.success("Article order saved");
        });
      }}
    >
      {children}
    </ul>
  );
}
