import { Button, Section, Text } from "@react-email/components";

import { Message, PostCard, type PostStatus } from "./blocks";
import { buttonStyle, colors, type EmailBrand, Eyebrow, FooterLink, Layout, Title } from "./layout";

/** How much of each comment the email quotes; the rest is on the post. */
const QUOTED = 1000;
/** How many comments one email shows; the rest are on the post. */
const SHOWN = 5;

type CommentProps = EmailBrand & {
  postTitle: string;
  voteCount: number;
  status: PostStatus;
  /** Its board's name, over its title. */
  board?: string;
  /** Oldest first, each as plain text; `authorId` tells people apart (two can share a name). */
  comments: { authorId: string; authorName: string; text: string }[];
  postUrl: string;
  unsubscribeUrl: string;
};

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** Who commented (each person once), by first name: "Sam", "Sam and Ada", "Sam and 2 others". */
function who(comments: CommentProps["comments"]) {
  const names = [...new Map(comments.map((comment) => [comment.authorId, comment.authorName])).values()].map(firstName);
  if (names.length <= 2) {
    return names.join(" and ");
  }
  return `${names[0]} and ${names.length - 1} others`;
}

const plural = (comments: CommentProps["comments"]) => (comments.length > 1 ? "New comments" : "New comment");

/** Someone else's comments on a post, sent to its author (those that came close together in one email). */
export function CommentEmail({ projectName, accent, poweredBy, postTitle, voteCount, status, board, comments, postUrl, unsubscribeUrl }: CommentProps) {
  const heading = `${who(comments)} commented on your idea`;
  const hidden = comments.length - SHOWN;
  return (
    <Layout
      preview={heading}
      project={{ projectName, accent, poweredBy }}
      footer={
        <>
          You get this because you posted this idea. <FooterLink href={unsubscribeUrl}>Unsubscribe from {projectName}</FooterLink>
        </>
      }
    >
      <Eyebrow accent={accent}>{plural(comments)} on your idea</Eyebrow>
      <Title>{heading}</Title>
      <PostCard title={postTitle} votes={voteCount} board={board} status={status} />
      {comments.slice(0, SHOWN).map((comment, index) => (
        // An image alone: its writer, no empty quote.
        <Message key={index} name={comment.authorName}>
          {comment.text.length > QUOTED ? `${comment.text.slice(0, QUOTED).trimEnd()}…` : comment.text || undefined}
        </Message>
      ))}
      {hidden > 0 && (
        <Text style={{ fontSize: 15, color: colors.muted, margin: "12px 0 0" }}>
          {hidden === 1 ? "1 more comment" : `${hidden} more comments`} on the post.
        </Text>
      )}
      <Section style={{ marginTop: 20 }}>
        <Button href={postUrl} style={buttonStyle(accent)}>
          Reply
        </Button>
      </Section>
    </Layout>
  );
}

export const commentEmail = (props: CommentProps) => ({
  subject: `${plural(props.comments)} on “${props.postTitle}”`,
  body: <CommentEmail {...props} />,
});
