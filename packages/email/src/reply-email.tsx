import { Button, Link, Text } from "@react-email/components";
import type { Doc } from "@tuti/content";
import type { MediaUrls } from "@tuti/content/media";

import { buttonStyle, colors, Layout } from "./layout";
import { EmailRichText } from "./rich-text";

/** How much of the reply the email quotes; the rest is on the post. */
const QUOTED = 1000;

/** `doc` and `mediaUrls` (lasting links): the reply's images, shown under the quoted text. */
type ReplyProps = {
  projectName: string;
  authorName: string;
  postTitle: string;
  text: string;
  doc?: Doc;
  mediaUrls?: MediaUrls | null;
  postUrl: string;
  unsubscribeUrl: string;
  /** The project's accent (Project.brandColor; null for Tuti's green): see accentColors. */
  accent?: string | null;
};

/** The team's reply to a post, sent to the people who voted for it (Email voters). */
export function ReplyEmail({ projectName, authorName, postTitle, text, doc, mediaUrls, postUrl, unsubscribeUrl, accent }: ReplyProps) {
  const quoted = text.length > QUOTED ? `${text.slice(0, QUOTED).trimEnd()}…` : text;
  // A comment's images are top-level blocks (its profile has no lists or quotes to hold one).
  const images = doc?.content?.filter((node) => node.type === "image") ?? [];
  return (
    <Layout preview={`${authorName} replied to ${postTitle}`} accent={accent}>
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>
        {authorName} from {projectName} replied to <strong>{postTitle}</strong>:
      </Text>
      {/* An image alone: no empty quote above it. */}
      {quoted && (
        <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px", whiteSpace: "pre-wrap", borderLeft: `3px solid ${colors.border}`, paddingLeft: 12 }}>
          {quoted}
        </Text>
      )}
      {images.length > 0 && <EmailRichText doc={{ type: "doc", content: images }} mediaUrls={mediaUrls} linkUrl={postUrl} accent={accent} />}
      <Button
        href={postUrl}
        style={buttonStyle(accent)}
      >
        See the post
      </Button>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        You&apos;re getting this because you voted for it.{" "}
        <Link href={unsubscribeUrl} style={{ color: colors.muted, textDecoration: "underline" }}>
          Unsubscribe from {projectName}
        </Link>
      </Text>
    </Layout>
  );
}

export const replyEmail = (props: ReplyProps) => ({
  subject: `Re: ${props.postTitle}`,
  body: <ReplyEmail {...props} />,
});
