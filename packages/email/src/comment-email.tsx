import { Button, Column, Row, Section, Text } from "@react-email/components";
import type { CSSProperties } from "react";

import { buttonStyle, colors, type EmailBrand, Eyebrow, FooterLink, Layout, Title } from "./layout";

/** How much of each comment the email quotes; the rest is on the post. */
const QUOTED = 1000;
/** How many comments one email shows; the rest are on the post. */
const SHOWN = 5;

/**
 * Post statuses as the app shows them (STATUS_LABELS, STATUS_STYLES in apps/web/src/components/post-status-badge.tsx):
 * the label, its colour for the dot and a light tint of it for the pill, as hex (the light theme's `status-*` tokens).
 */
const STATUSES: Record<string, { label: string; dot: string; tint: string }> = {
  OPEN: { label: "Open", dot: "#98918b", tint: "#f3f2f1" },
  UNDER_REVIEW: { label: "Under review", dot: "#eea40b", tint: "#fcf0d8" },
  PLANNED: { label: "Planned", dot: "#8254c4", tint: "#eee7f7" },
  IN_PROGRESS: { label: "In progress", dot: "#1a83db", tint: "#daebf9" },
  COMPLETED: { label: "Completed", dot: "#17a750", tint: "#daf1e3" },
  CLOSED: { label: "Closed", dot: "#d2cdc7", tint: "#f4f2f1" },
};

type CommentProps = EmailBrand & {
  postTitle: string;
  voteCount: number;
  /** The post's status (PostStatus). */
  status: string;
  /** Oldest first, each as plain text; `authorId` tells people apart (two can share a name). */
  comments: { authorId: string; authorName: string; text: string }[];
  postUrl: string;
  unsubscribeUrl: string;
};

const votes = (count: number) => `${count} ${count === 1 ? "vote" : "votes"}`;

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
export function CommentEmail({ projectName, accent, poweredBy, postTitle, voteCount, status, comments, postUrl, unsubscribeUrl }: CommentProps) {
  const pill = STATUSES[status] ?? STATUSES.OPEN!;
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
      <Section style={{ backgroundColor: colors.mutedBackground, borderRadius: 12, padding: "12px 14px" }}>
        <Row>
          <Column style={{ width: 48, verticalAlign: "middle" }}>
            <Text style={{ fontSize: 15, fontWeight: 600, color: colors.text, textAlign: "center", backgroundColor: colors.card, border: `1px solid ${colors.border}`, borderRadius: 8, margin: 0, padding: "4px 0", lineHeight: "18px" }}>
              {/* The arrow is decoration; the count is labelled "N votes" for screen readers and in the plain text (#859's PostCard). */}
              <span aria-hidden="true" data-skip-in-text="true" style={{ display: "block" }}>
                &#9650;
              </span>
              <span role="img" aria-label={votes(voteCount)} style={{ display: "block" }}>
                {voteCount}
                <span style={{ display: "none", msoHide: "all" } as CSSProperties}> {voteCount === 1 ? "vote" : "votes"}</span>
              </span>
            </Text>
          </Column>
          <Column style={{ verticalAlign: "middle", paddingLeft: 12 }}>
            <Text style={{ fontSize: 15, fontWeight: 600, color: colors.text, lineHeight: "22px", margin: 0 }}>{postTitle}</Text>
            <Text style={{ fontSize: 13, color: colors.text, margin: "6px 0 0", lineHeight: "18px" }}>
              <span style={{ backgroundColor: pill.tint, borderRadius: 999, padding: "2px 10px", whiteSpace: "nowrap" }}>
                <span aria-hidden="true" data-skip-in-text="true" style={{ color: pill.dot }}>
                  &#9679;&nbsp;
                </span>
                {pill.label}
              </span>
            </Text>
          </Column>
        </Row>
      </Section>
      {comments.slice(0, SHOWN).map((comment, index) => {
        const quoted = comment.text.length > QUOTED ? `${comment.text.slice(0, QUOTED).trimEnd()}…` : comment.text;
        return (
          <Section key={index} style={{ marginTop: 16 }}>
            <Text style={{ fontSize: 15, fontWeight: 600, color: colors.text, margin: "0 0 6px" }}>{comment.authorName}</Text>
            {/* An image alone: no empty quote. */}
            {quoted && (
              <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px", whiteSpace: "pre-wrap", backgroundColor: colors.mutedBackground, borderRadius: 12, padding: "10px 14px", margin: 0 }}>
                {quoted}
              </Text>
            )}
          </Section>
        );
      })}
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
