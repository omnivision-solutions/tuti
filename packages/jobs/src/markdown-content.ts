import type { Profile } from "@tuti/content";
import { htmlToContent } from "@tuti/content/html";
import { marked } from "marked";

import { mediaImporter } from "./import-media";

/** How long an API request waits for the images its Markdown links to: those not copied by then are left out. */
const COPY_TIME_MS = 30_000;

/**
 * Markdown an API client sends (release notes, say) as rich content: rendered to HTML and read as imports read it, the
 * images it links to copied into the project's media. Network I/O: never call it under the project lock.
 */
export function markdownToContent(profile: Profile, markdown: string, { projectId, uploaderId }: { projectId: string; uploaderId: string }) {
  const media = mediaImporter({ projectId, uploaderId, deadline: Date.now() + COPY_TIME_MS });
  return htmlToContent(profile, marked.parse(markdown, { async: false }), { media });
}
