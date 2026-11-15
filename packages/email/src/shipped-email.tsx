import { Button } from "@react-email/components";

import { Message, Paragraph, PostCard, type PostStatus } from "./blocks";
import { buttonStyle, type EmailBrand, Eyebrow, FooterLink, Layout, Title } from "./layout";

/** `note`: the team's comment posted with the completion, quoted under the news. */
type ShippedProps = EmailBrand & {
  postTitle: string;
  /** The post's votes, board and status, shown in its card. */
  votes?: number;
  board?: string;
  status?: PostStatus;
  postUrl: string;
  unsubscribeUrl: string;
  note?: { from: string; text: string };
};

export function ShippedEmail({ projectName, postTitle, votes, board, status = "COMPLETED", postUrl, unsubscribeUrl, note, accent, poweredBy }: ShippedProps) {
  return (
    <Layout
      preview={`${postTitle} is done.`}
      project={{ projectName, accent, poweredBy }}
      footer={
        <>
          You&apos;re getting this because you posted, voted, commented on or subscribed to it.{" "}
          <FooterLink href={unsubscribeUrl}>Unsubscribe from {projectName}</FooterLink>
        </>
      }
    >
      <Eyebrow accent={accent}>An idea you asked for is live</Eyebrow>
      <Title>{postTitle} is done</Title>
      <Paragraph>Good news from {projectName}. Thanks for asking for it.</Paragraph>
      <PostCard title={postTitle} votes={votes} board={board} status={status} />
      {note && (
        <Message name={note.from} team={`${projectName} team`} accent={accent}>
          {note.text}
        </Message>
      )}
      <Button
        href={postUrl}
        style={buttonStyle(accent)}
      >
        See the post
      </Button>
    </Layout>
  );
}

export const shippedEmail = (props: ShippedProps) => ({
  subject: `Done: ${props.postTitle}`,
  body: <ShippedEmail {...props} />,
});
