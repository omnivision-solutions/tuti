import { type Extensions, getSchema, Node } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";

import { isSafeLink, isVideo, LINK_REL, VIDEO_SANDBOX, videoEmbedUrl } from "./links";

/**
 * What each kind of content may contain. The editor, the server-side validation
 * and the renderers all derive from these, so they agree on every node and mark.
 * Changelog and article profiles come with those features (Phases 8 and 10).
 */
export const PROFILES = ["comment", "post"] as const;
export type Profile = (typeof PROFILES)[number];

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    video: { setVideo: (video: { provider: string; id: string }) => ReturnType };
  }
}

/** A video from an allowed provider, stored as provider + id and embedded from a known URL. */
export const VideoEmbed = Node.create({
  name: "video",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { provider: { default: null }, id: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: "div[data-video]",
        getAttrs: (element) => ({ provider: element.getAttribute("data-provider"), id: element.getAttribute("data-id") }),
      },
    ];
  },
  renderHTML({ node }) {
    const video = { provider: node.attrs.provider as unknown, id: node.attrs.id as unknown };
    return [
      "div",
      { "data-video": "", "data-provider": String(video.provider), "data-id": String(video.id), class: "rich-video" },
      [
        "iframe",
        {
          src: isVideo(video) ? videoEmbedUrl(video) : "about:blank",
          sandbox: VIDEO_SANDBOX,
          allowfullscreen: "true",
          loading: "lazy",
          title: "Video",
        },
      ],
    ];
  },
  addCommands() {
    return {
      setVideo:
        (video) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: video }),
    };
  },
});

const textOnly = {
  heading: false,
  blockquote: false,
  horizontalRule: false,
  strike: false,
  underline: false,
  link: {
    openOnClick: false,
    autolink: true,
    defaultProtocol: "https",
    isAllowedUri: (url: string) => isSafeLink(url),
    HTMLAttributes: { rel: LINK_REL, target: "_blank" },
  },
} as const;

export function extensions(profile: Profile): Extensions {
  switch (profile) {
    case "comment":
      return [
        StarterKit.configure({
          ...textOnly,
          bulletList: false,
          orderedList: false,
          listItem: false,
          listKeymap: false,
          codeBlock: false,
        }),
      ];
    case "post":
      return [StarterKit.configure(textOnly), VideoEmbed];
  }
}

const schemas = new Map<Profile, Schema>();

export function schemaFor(profile: Profile): Schema {
  let schema = schemas.get(profile);
  if (!schema) {
    schema = getSchema(extensions(profile));
    schemas.set(profile, schema);
  }
  return schema;
}
