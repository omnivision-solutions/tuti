import { Button, Column, Link, Row, Section, Text } from "@react-email/components";

import { accentColors, buttonStyle, colors, Layout } from "./layout";

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

type CommentProps = {
  projectName: string;
  postTitle: string;
  voteCount: number;
  /** The post's status (PostStatus). */
  status: string;
  /** Oldest first, each as plain text; `authorId` tells people apart (two can share a name). */
  comments: { authorId: string; authorName: string; text: string }[];
  postUrl: string;
  unsubscribeUrl: string;
  /** The project's accent (Project.brandColor; null for Tuti's green): see accentColors. */
  accent?: string | null;
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
export function CommentEmail({ projectName, postTitle, voteCount, status, comments, postUrl, unsubscribeUrl, accent }: CommentProps) {
  const pill = STATUSES[status] ?? STATUSES.OPEN!;
  const heading = `${who(comments)} commented on your idea`;
  const hidden = comments.length - SHOWN;
  return (
    <Layout preview={heading} accent={accent}>
      <Text style={{ fontSize: 14, fontWeight: 600, color: accentColors(accent).link, margin: "20px 0 0" }}>{plural(comments)} on your idea</Text>
      <Text style={{ fontSize: 22, fontWeight: 700, color: colors.text, lineHeight: "28px", margin: "4px 0 16px" }}>{heading}</Text>
      <Section style={{ backgroundColor: colors.mutedBackground, borderRadius: 12, padding: "12px 14px" }}>
        <Row>
          <Column style={{ width: 48, verticalAlign: "middle" }}>
            <Text style={{ fontSize: 15, fontWeight: 600, color: colors.text, textAlign: "center", backgroundColor: colors.card, border: `1px solid ${colors.border}`, borderRadius: 8, margin: 0, padding: "4px 0", lineHeight: "18px" }}>
              ▲<br />
              {voteCount}
            </Text>
          </Column>
          <Column style={{ verticalAlign: "middle", paddingLeft: 12 }}>
            <Text style={{ fontSize: 15, fontWeight: 600, color: colors.text, lineHeight: "22px", margin: 0 }}>{postTitle}</Text>
            <Text style={{ fontSize: 13, color: colors.text, margin: "6px 0 0", lineHeight: "18px" }}>
              <span style={{ backgroundColor: pill.tint, borderRadius: 999, padding: "2px 10px", whiteSpace: "nowrap" }}>
                <span style={{ color: pill.dot }}>●</span> {pill.label}
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
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        You get this because you posted this idea.{" "}
        <Link href={unsubscribeUrl} style={{ color: colors.muted, textDecoration: "underline" }}>
          Unsubscribe from {projectName}
        </Link>
      </Text>
    </Layout>
  );
}

export const commentEmail = (props: CommentProps) => ({
  subject: `${plural(props.comments)} on “${props.postTitle}”`,
  body: <CommentEmail {...props} />,
});
