/**
 * The one link policy for user content (posts, comments, changelogs, articles).
 * The editor, the server-side validation and the renderers all use it, so a link
 * that gets past one can't get past another.
 */

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const MAX_URL_LENGTH = 2048;

/** Only http, https and mailto, as absolute URLs (no javascript:, data:, relative or protocol-relative). */
export function isSafeLink(href: unknown): href is string {
  if (typeof href !== "string" || href.length > MAX_URL_LENGTH || href !== href.trim()) {
    return false;
  }
  try {
    return SAFE_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

/** Attributes every rendered link gets: user content never gets our referrer, opener or ranking. */
export const LINK_REL = "noopener noreferrer nofollow ugc";

export const VIDEO_PROVIDERS = ["youtube", "vimeo", "loom"] as const;
export type VideoProvider = (typeof VIDEO_PROVIDERS)[number];
export type Video = { provider: VideoProvider; id: string };

const VIDEO_ID: Record<VideoProvider, RegExp> = {
  youtube: /^[A-Za-z0-9_-]{11}$/,
  vimeo: /^\d{1,12}$/,
  loom: /^[a-f0-9]{32}$/,
};

export function isVideo(value: { provider?: unknown; id?: unknown }): value is Video {
  return (
    typeof value.provider === "string" &&
    (VIDEO_PROVIDERS as readonly string[]).includes(value.provider) &&
    typeof value.id === "string" &&
    VIDEO_ID[value.provider as VideoProvider].test(value.id)
  );
}

/**
 * A video from a pasted URL, if it's from an allowed provider. Only the provider
 * and id are kept; pages embed from `videoEmbedUrl`, never from the pasted URL.
 */
export function parseVideoUrl(input: string): Video | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  const host = url.hostname.replace(/^(www|m)\./, "");
  const path = url.pathname.split("/").filter(Boolean);

  let video: { provider: VideoProvider; id: string | undefined } | null = null;
  if (host === "youtu.be") {
    video = { provider: "youtube", id: path[0] };
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const id = path[0] === "watch" ? url.searchParams.get("v") : ["embed", "shorts", "live"].includes(path[0] ?? "") ? path[1] : null;
    video = { provider: "youtube", id: id ?? undefined };
  } else if (host === "vimeo.com") {
    // ponytail: unlisted Vimeo links (vimeo.com/<id>/<hash>) need the hash in the embed; add it if people ask.
    video = { provider: "vimeo", id: path[0] };
  } else if (host === "player.vimeo.com" && path[0] === "video") {
    video = { provider: "vimeo", id: path[1] };
  } else if (host === "loom.com" && (path[0] === "share" || path[0] === "embed")) {
    video = { provider: "loom", id: path[1] };
  }
  return video && isVideo(video) ? { provider: video.provider, id: video.id } : null;
}

/** The only URLs a video embed's iframe ever loads. */
export function videoEmbedUrl({ provider, id }: Video): string {
  switch (provider) {
    case "youtube":
      return `https://www.youtube-nocookie.com/embed/${id}`;
    case "vimeo":
      return `https://player.vimeo.com/video/${id}`;
    case "loom":
      return `https://www.loom.com/embed/${id}`;
  }
}

/** Where people watch it (for emails and plain text). */
export function videoPageUrl({ provider, id }: Video): string {
  switch (provider) {
    case "youtube":
      return `https://www.youtube.com/watch?v=${id}`;
    case "vimeo":
      return `https://vimeo.com/${id}`;
    case "loom":
      return `https://www.loom.com/share/${id}`;
  }
}

/** `sandbox` for embed iframes: enough for the players to run, nothing that reaches our page. */
export const VIDEO_SANDBOX = "allow-scripts allow-same-origin allow-presentation allow-popups";
