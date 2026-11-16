import { Button } from "@react-email/components";
import type { Doc } from "@tuti/content";
import type { MediaUrls } from "@tuti/content/media";

import { Message, PostCard, type PostStatus } from "./blocks";
import { buttonStyle, type EmailBrand, Eyebrow, FooterLink, Layout, Title } from "./layout";
import { EmailRichText } from "./rich-text";

/** How much of the reply the email quotes; the rest is on the post. */
const QUOTED = 1000;

/** `doc` and `mediaUrls` (lasting links): the reply's images, shown under the quoted text. */
type ReplyProps = EmailBrand & {
  authorName: string;
  postTitle: string;
  /** The post's votes, board and status, shown in its card. */
  votes?: number;
  board?: string;
  status?: PostStatus;
  text: string;
  doc?: Doc;
  mediaUrls?: MediaUrls | null;
  postUrl: string;
  unsubscribeUrl: string;
};

/** The team's reply to a post, sent to the people who voted for it (Email voters). */
export function ReplyEmail({ projectName, authorName, postTitle, votes, board, status, text, doc, mediaUrls, postUrl, unsubscribeUrl, accent, poweredBy, logo, logoText }: ReplyProps) {
  const quoted = text.length > QUOTED ? `${text.slice(0, QUOTED).trimEnd()}…` : text;
  // A comment's images are top-level blocks (its profile has no lists or quotes to hold one).
  const images = doc?.content?.filter((node) => node.type === "image") ?? [];
  return (
    <Layout
      preview={`${authorName} replied to ${postTitle}`}
      project={{ projectName, accent, poweredBy, logo, logoText }}
      footer={
        <>
          You&apos;re getting this because you voted for it. <FooterLink href={unsubscribeUrl}>Unsubscribe from {projectName}</FooterLink>
        </>
      }
    >
      <Eyebrow accent={accent}>New reply on an idea you voted for</Eyebrow>
      <Title>
        {authorName} from {projectName} replied
      </Title>
      <PostCard title={postTitle} votes={votes} board={board} status={status} />
      {/* An image alone: no empty quote above it. */}
      <Message name={authorName} team={`${projectName} team`} accent={accent}>
        {quoted}
      </Message>
      {images.length > 0 && <EmailRichText doc={{ type: "doc", content: images }} mediaUrls={mediaUrls} linkUrl={postUrl} accent={accent} />}
      <Button
        href={postUrl}
        style={buttonStyle(accent)}
      >
        Reply on the post
      </Button>
    </Layout>
  );
}

export const replyEmail = (props: ReplyProps) => ({
  subject: `Re: ${props.postTitle}`,
  body: <ReplyEmail {...props} />,
});
