import { Button, Text } from "@react-email/components";
import type { Doc } from "@tuti/content";
import type { MediaUrls } from "@tuti/content/media";

import { buttonStyle, colors, type EmailBrand, FooterLink, Layout } from "./layout";
import { EmailRichText } from "./rich-text";

/** How much of the reply the email quotes; the rest is on the post. */
const QUOTED = 1000;

/** `doc` and `mediaUrls` (lasting links): the reply's images, shown under the quoted text. */
type ReplyProps = EmailBrand & {
  authorName: string;
  postTitle: string;
  text: string;
  doc?: Doc;
  mediaUrls?: MediaUrls | null;
  postUrl: string;
  unsubscribeUrl: string;
};

/** The team's reply to a post, sent to the people who voted for it (Email voters). */
export function ReplyEmail({ projectName, authorName, postTitle, text, doc, mediaUrls, postUrl, unsubscribeUrl, accent, poweredBy }: ReplyProps) {
  const quoted = text.length > QUOTED ? `${text.slice(0, QUOTED).trimEnd()}…` : text;
  // A comment's images are top-level blocks (its profile has no lists or quotes to hold one).
  const images = doc?.content?.filter((node) => node.type === "image") ?? [];
  return (
    <Layout
      preview={`${authorName} replied to ${postTitle}`}
      project={{ projectName, accent, poweredBy }}
      footer={
        <>
          You&apos;re getting this because you voted for it. <FooterLink href={unsubscribeUrl}>Unsubscribe from {projectName}</FooterLink>
        </>
      }
    >
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
    </Layout>
  );
}

export const replyEmail = (props: ReplyProps) => ({
  subject: `Re: ${props.postTitle}`,
  body: <ReplyEmail {...props} />,
});
