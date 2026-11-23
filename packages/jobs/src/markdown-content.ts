import type { Profile } from "@tuti/content";
import { type HtmlContent, htmlToContent } from "@tuti/content/html";
import { marked } from "marked";

import { mediaImporter } from "./import-media";

/** How long an API request waits for the images its Markdown links to: those not copied by then are left out. */
const COPY_TIME_MS = 30_000;

/**
 * Markdown an API client sends (release notes, say) as rich content: rendered to HTML and read as imports read it, the
 * images it links to copied into the project's media as `uploaderId`'s uploads, held to the same limits as uploads from
 * the app. Text over `maxLength` is refused before any image is copied. Network I/O: never call it under the project lock.
 */
export async function markdownToContent(
  profile: Profile,
  markdown: string,
  { projectId, uploaderId, maxLength }: { projectId: string; uploaderId: string; maxLength: number },
): Promise<HtmlContent | { error: string }> {
  const html = marked.parse(markdown, { async: false });
  const words = await htmlToContent(profile, html);
  if ("error" in words || words.text.length > maxLength) {
    return "error" in words ? words : { error: `Keep it under ${maxLength.toLocaleString("en")} characters` };
  }
  const media = mediaImporter({ projectId, uploaderId, deadline: Date.now() + COPY_TIME_MS, upload: true });
  return htmlToContent(profile, html, { media });
}
