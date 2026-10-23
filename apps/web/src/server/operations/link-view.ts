import type { PostLinkKind } from "@tuti/db";

/** How links look in the API. */
const KINDS: Record<PostLinkKind, string> = { PULL_REQUEST: "pull_request", ISSUE: "issue", RELEASE: "release" };

export const linkView = (link: {
  id: string;
  kind: PostLinkKind;
  repo: string;
  number: number | null;
  tag: string | null;
  url: string;
  title: string | null;
  codeChangeId: string | null;
}) => ({
  id: link.id,
  kind: KINDS[link.kind],
  repo: link.repo,
  number: link.number,
  tag: link.tag,
  url: link.url,
  title: link.title,
  /** The code change whose applied action added it (codeChanges.get), if one did. */
  codeChange: link.codeChangeId,
});

export const linkSelect = { id: true, kind: true, repo: true, number: true, tag: true, url: true, title: true, codeChangeId: true } as const;
