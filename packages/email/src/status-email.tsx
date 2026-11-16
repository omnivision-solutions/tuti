import { Button } from "@react-email/components";

import { Message, Paragraph, PostCard, STATUS_PILLS } from "./blocks";
import { buttonStyle, type EmailBrand, Eyebrow, FooterLink, Layout, Title } from "./layout";

/** The statuses a post's people hear about before it ships (Completed's is the shipped email), each as it reads. */
const STATUSES = {
  PLANNED: { is: "is planned", next: "The team plans to build it." },
  IN_PROGRESS: { is: "is in progress", next: "The team has started building it." },
} as const;

export type ProgressStatus = keyof typeof STATUSES;

/** `note`: the team's comment posted with the change, quoted under the news. `board`: left out for a Team only board's. */
type StatusProps = EmailBrand & {
  status: ProgressStatus;
  postTitle: string;
  board?: string;
  votes: number;
  postUrl: string;
  unsubscribeUrl: string;
  note?: { from: string; text: string };
};

export function StatusEmail({ projectName, accent, poweredBy, logo, logoText, status, postTitle, board, votes, postUrl, unsubscribeUrl, note }: StatusProps) {
  const { is, next } = STATUSES[status];
  return (
    <Layout
      preview={`An idea you're following moved to ${STATUS_PILLS[status].label}`}
      project={{ projectName, accent, poweredBy, logo, logoText }}
      footer={
        <>
          You&apos;re getting this because you posted, voted, commented on or subscribed to it.{" "}
          <FooterLink href={unsubscribeUrl}>Unsubscribe from {projectName}</FooterLink>
        </>
      }
    >
      <Eyebrow accent={accent}>Update on an idea you asked for</Eyebrow>
      <Title>
        {postTitle} {is}
      </Title>
      <PostCard title={postTitle} votes={votes} board={board} status={status} />
      <Paragraph>{next} We&apos;ll email you again when it ships.</Paragraph>
      {note && (
        <Message name={note.from} team={`${projectName} team`} accent={accent}>
          {note.text}
        </Message>
      )}
      <Button href={postUrl} style={buttonStyle(accent)}>
        See the idea
      </Button>
    </Layout>
  );
}

export const statusEmail = (props: StatusProps) => ({
  subject: `${STATUS_PILLS[props.status].label}: ${props.postTitle}`,
  body: <StatusEmail {...props} />,
});
