import { RichText } from "@tuti/content/react";

import { diffBlocks } from "@/lib/line-diff";
import { displayDoc } from "@/server/content";
import { mediaUrls } from "@/server/media-urls";

type ArticleVersion = { title: string; body: string; content: unknown; collection: { name: string } | null };

/** What changed from one version of an article to another: its title, collection and blocks, formatted as readers see them. `same` says there's nothing. */
export async function ArticleDiff({ before, after, same }: { before: ArticleVersion; after: ArticleVersion; same: string }) {
  const [a, b] = [displayDoc(before), displayDoc(after)];
  const blocks = diffBlocks(a, b);
  const fields = [
    { label: "Title", before: before.title, after: after.title },
    { label: "Collection", before: before.collection?.name ?? "None", after: after.collection?.name ?? "None" },
  ].filter((field) => field.before !== field.after);
  if (fields.length === 0 && blocks.every((block) => block.kind === "same")) {
    return <p className="text-sm text-muted-foreground">{same}</p>;
  }
  const media = await mediaUrls(a, b);
  return (
    <div className="flex flex-col gap-1 text-sm break-words">
      {fields.map((field) => (
        <p key={field.label} className="mb-2">
          {field.label}: <del className="bg-destructive/10 text-destructive">{field.before}</del>{" "}
          <ins className="bg-soft text-soft-foreground no-underline">{field.after}</ins>
        </p>
      ))}
      {blocks.map(({ kind, doc }, index) => {
        const text = <RichText doc={doc} mediaUrls={media} className="rich-text" />;
        return kind === "same" ? (
          <div key={index} className="px-2 py-1 text-muted-foreground">
            {text}
          </div>
        ) : kind === "removed" ? (
          <del key={index} className="block rounded-md bg-destructive/10 px-2 py-1 text-destructive">
            {text}
          </del>
        ) : (
          <ins key={index} className="block rounded-md bg-soft px-2 py-1 text-soft-foreground no-underline">
            {text}
          </ins>
        );
      })}
    </div>
  );
}
