import type { PostLinkKind } from "@tuti/db";

export type GitHubLink = { kind: PostLinkKind; repo: string; number: number | null; tag: string | null; url: string };

const NAME = "[A-Za-z0-9_.-]{1,100}";
const PATTERN = new RegExp(`^/(${NAME})/(${NAME})/(?:(pull|issues)/(\\d{1,9})|releases/tag/([^/?#]{1,200}))/?$`);

/** A GitHub pull request, issue or release from its URL (anything after it, like /files, is dropped). */
export function parseGitHubUrl(input: string): GitHubLink | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || (url.hostname !== "github.com" && url.hostname !== "www.github.com")) {
    return null;
  }
  // /owner/repo/pull/12/files → /owner/repo/pull/12
  const path = url.pathname.replace(/^(\/[^/]+\/[^/]+\/(?:pull|issues)\/\d+)\/.*$/, "$1");
  const match = PATTERN.exec(path);
  if (!match) {
    return null;
  }
  const [, owner, name, type, number, tag] = match;
  const repo = `${owner}/${name}`;
  if (tag !== undefined) {
    return { kind: "RELEASE", repo, number: null, tag: decodeURIComponent(tag), url: `https://github.com/${repo}/releases/tag/${tag}` };
  }
  return {
    kind: type === "pull" ? "PULL_REQUEST" : "ISSUE",
    repo,
    number: Number(number),
    tag: null,
    url: `https://github.com/${repo}/${type}/${number}`,
  };
}
