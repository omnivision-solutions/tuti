import type { JSONContent } from "@tiptap/core";
import { toMarkdown } from "@tuti/content";
import { prisma } from "@tuti/db";
import { mediaPublicUrl } from "@tuti/shared/storage";
import { strToU8, Zip, ZipDeflate } from "fflate";

import { titleSlug } from "@/lib/post-urls";

import { displayDoc } from "./content";

/**
 * "Export as Markdown": everything a project wrote, as a ZIP of Markdown files with
 * YAML front matter. Streamed: rows are read in batches as the client downloads, so
 * no export is held in memory whole. Images stay links to where they're hosted.
 */
export function exportZip(project: { id: string; name: string }, exportedAt = new Date()): ReadableStream<Uint8Array> {
  const files = exportFiles(project, exportedAt);
  let zip: Zip;
  return new ReadableStream({
    start(controller) {
      zip = new Zip((error, chunk, final) => {
        if (error) {
          controller.error(error);
          return;
        }
        controller.enqueue(chunk);
        if (final) {
          controller.close();
        }
      });
    },
    // One file per pull, so a slow download holds back the reads.
    async pull() {
      const next = await files.next();
      if (next.done) {
        zip.end();
        return;
      }
      const [path, text] = next.value;
      const file = new ZipDeflate(path, { level: 6 });
      zip.add(file);
      file.push(strToU8(text), true);
    },
    async cancel() {
      await files.return(undefined);
    },
  });
}

const BATCH = 100;

/** Every row `read` returns, a batch at a time, in id order. */
async function* batches<T extends { id: string }>(read: (after: string, take: number) => Promise<T[]>) {
  for (let after = ""; ; ) {
    const rows = await read(after, BATCH);
    yield* rows;
    if (rows.length < BATCH) {
      return;
    }
    after = rows.at(-1)!.id;
  }
}

async function* exportFiles(project: { id: string; name: string }, exportedAt: Date): AsyncGenerator<[string, string]> {
  const projectId = project.id;
  const media = { mediaBaseUrl: mediaPublicUrl() };
  const body = (row: { content: unknown; body: string }, more: JSONContent[] = []) => {
    const doc = displayDoc(row);
    return `${toMarkdown({ type: "doc", content: [...(doc.content ?? []), ...more] }, media)}\n`;
  };
  const status = (publishedAt: Date | null) => (publishedAt ? "published" : "draft");

  yield ["README.md", readme(project.name, exportedAt)];

  for await (const article of batches((after, take) =>
    prisma.article.findMany({
      where: { projectId, deletedAt: null, id: { gt: after } },
      orderBy: { id: "asc" },
      take,
      select: {
        id: true,
        slug: true,
        title: true,
        body: true,
        content: true,
        publishedAt: true,
        listing: true,
        updatedAt: true,
        order: true,
        collection: {
          select: {
            slug: true,
            name: true,
            tab: { select: { slug: true, name: true } },
            parent: { select: { slug: true, tab: { select: { slug: true, name: true } } } },
          },
        },
      },
    }),
  )) {
    // A collection in another is a folder in its folder (collections go 2 levels deep at most), in its section's folder.
    const section = article.collection?.parent ? article.collection.parent.tab : article.collection?.tab;
    const folder = ["help", section?.slug, article.collection?.parent?.slug, article.collection?.slug].filter(Boolean).join("/");
    yield [
      `${folder}/${article.slug}.md`,
      frontMatter({
        title: article.title,
        status: status(article.publishedAt),
        // The team's own copy: every listing is in it, saying which (as the API names it).
        listing: article.listing.toLowerCase(),
        publishedAt: article.publishedAt,
        updatedAt: article.updatedAt,
        // Only with sections.
        ...(section && { section: section.name }),
        collection: article.collection?.name ?? null,
        // Its place in the collection (or among the articles in none): 0 first.
        order: article.order,
      }) + body(article),
    ];
  }

  for await (const entry of batches((after, take) =>
    prisma.changelogEntry.findMany({
      where: { projectId, id: { gt: after } },
      orderBy: { id: "asc" },
      take,
      select: { id: true, number: true, title: true, body: true, content: true, tags: true, publishedAt: true, posts: { select: { post: { select: { number: true } } } } },
    }),
  )) {
    yield [
      `changelog/${entry.number}-${titleSlug(entry.title, "entry")}.md`,
      frontMatter({
        title: entry.title,
        status: status(entry.publishedAt),
        publishedAt: entry.publishedAt,
        tags: entry.tags.map((tag) => tag.toLowerCase()),
        completes: entry.posts.map(({ post }) => post.number).sort((a, b) => a - b),
      }) + body(entry),
    ];
  }

  for await (const post of batches((after, take) =>
    prisma.post.findMany({
      where: { projectId, id: { gt: after } },
      orderBy: { id: "asc" },
      take,
      select: {
        id: true,
        number: true,
        title: true,
        body: true,
        content: true,
        status: true,
        voteCount: true,
        createdAt: true,
        board: { select: { slug: true } },
        author: { select: { name: true } },
        comments: {
          orderBy: { createdAt: "asc" },
          select: { body: true, content: true, createdAt: true, author: { select: { name: true } } },
        },
      },
    }),
  )) {
    const comments: JSONContent[] =
      post.comments.length === 0
        ? []
        : [
            heading(2, "Comments"),
            ...post.comments.flatMap((comment) => [
              heading(3, `${comment.author.name} · ${comment.createdAt.toISOString().slice(0, 10)}`),
              ...(displayDoc(comment).content ?? []),
            ]),
          ];
    yield [
      `posts/${post.board.slug}/${post.number}-${titleSlug(post.title)}.md`,
      frontMatter({
        title: post.title,
        status: post.status.toLowerCase(),
        votes: post.voteCount,
        author: post.author.name,
        createdAt: post.createdAt,
      }) + body(post, comments),
    ];
  }
}

const heading = (level: number, text: string): JSONContent => ({ type: "heading", attrs: { level }, content: [{ type: "text", text }] });

/** YAML front matter; strings as JSON (valid YAML), so any title reads back as written. */
function frontMatter(fields: Record<string, unknown>): string {
  const value = (v: unknown) => (v instanceof Date ? v.toISOString() : JSON.stringify(v ?? null));
  return `---\n${Object.entries(fields)
    .map(([key, v]) => `${key}: ${value(v)}`)
    .join("\n")}\n---\n\n`;
}

function readme(projectName: string, exportedAt: Date): string {
  return `${toMarkdown({ type: "doc", content: [heading(1, projectName)] })}

Exported from Tuti on ${exportedAt.toISOString()}.

- \`help/\`: the articles in your docs, drafts and every listing (everywhere, unlisted, hidden, AI only) included, in a folder per collection (a collection in another is a folder in its folder, and with sections each section is a folder with its collections; articles in no collection are directly in \`help/\`). \`order\` in the front matter is an article's place in its collection.
- \`changelog/\`: changelog entries, drafts included, as \`<number>-<title>.md\`.
- \`posts/\`: feedback posts in a folder per board, as \`<number>-<title>.md\`, with their comments at the end.

Each file starts with YAML front matter (title, status, dates and more), then the content as Markdown.
People are named by their display name only; email addresses aren't included.

Known limit: images aren't in this ZIP. They stay links to where they're hosted, so download any you need to keep.
`;
}
