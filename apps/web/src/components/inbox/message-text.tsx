import { Fragment } from "react";

import { linkParts } from "@/lib/message-links";

/** A message's text with its web addresses as links, in a new tab; `ugc` for what customers wrote. */
export function MessageText({ text, ugc }: { text: string; ugc: boolean }) {
  return linkParts(text).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel={ugc ? "noopener noreferrer nofollow ugc" : "noopener noreferrer"} className="underline underline-offset-4">
        {part}
      </a>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}
