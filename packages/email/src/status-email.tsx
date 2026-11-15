import { Button, Column, Link, Row, Section, Text } from "@react-email/components";

import { accentColors, buttonStyle, colors, Layout } from "./layout";

/** The statuses a post's people hear about before it ships (Completed's is the shipped email), each as it reads. */
const STATUSES = {
  PLANNED: { label: "Planned", is: "is planned", next: "The team plans to build it.", pill: { background: "#f1ebfe", color: "#6d28d9", dot: "#8b5cf6" } },
  IN_PROGRESS: { label: "In progress", is: "is in progress", next: "The team has started building it.", pill: { background: "#e6f0fd", color: "#1d4ed8", dot: "#3b82f6" } },
} as const;

export type ProgressStatus = keyof typeof STATUSES;

/** `note`: the team's comment posted with the change, quoted under the news. */
type StatusProps = {
  projectName: string;
  status: ProgressStatus;
  postTitle: string;
  boardName: string;
  votes: number;
  postUrl: string;
  unsubscribeUrl: string;
  note?: { from: string; text: string };
  accent?: string | null;
};

export function StatusEmail({ projectName, status, postTitle, boardName, votes, postUrl, unsubscribeUrl, note, accent }: StatusProps) {
  const { label, is, next, pill } = STATUSES[status];
  return (
    <Layout preview={`An idea you voted for moved to ${label}`} accent={accent}>
      <Text style={{ fontSize: 14, fontWeight: 600, color: accentColors(accent).link, margin: "16px 0 4px" }}>Update on an idea you voted for</Text>
      <Text style={{ fontSize: 22, fontWeight: 700, color: colors.text, lineHeight: "28px", margin: "0 0 16px" }}>
        {postTitle} {is}
      </Text>
      <Section style={{ backgroundColor: colors.mutedBackground, borderRadius: 12, padding: "12px 14px" }}>
        <Row>
          <Column style={{ width: 48, verticalAlign: "middle" }}>
            <Text style={{ margin: 0, width: 40, textAlign: "center", fontSize: 15, fontWeight: 700, color: colors.text, backgroundColor: colors.card, border: `1px solid ${colors.border}`, borderRadius: 8, lineHeight: "18px", padding: "4px 0" }}>
              ▲<br />
              {votes}
            </Text>
          </Column>
          <Column style={{ verticalAlign: "middle", paddingLeft: 8 }}>
            <Text style={{ margin: 0, fontSize: 13, color: colors.muted, lineHeight: "18px" }}>{boardName}</Text>
            <Text style={{ margin: 0, fontSize: 15, fontWeight: 600, color: colors.text, lineHeight: "20px" }}>{postTitle}</Text>
          </Column>
          <Column style={{ width: 1, verticalAlign: "middle", whiteSpace: "nowrap" }}>
            <Text style={{ margin: 0, fontSize: 12, fontWeight: 600, color: pill.color, backgroundColor: pill.background, borderRadius: 999, padding: "3px 10px" }}>
              <span style={{ color: pill.dot }}>●</span> {label}
            </Text>
          </Column>
        </Row>
      </Section>
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>{next} We&apos;ll email you again when it ships.</Text>
      {note && (
        <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px", whiteSpace: "pre-line", borderLeft: `3px solid ${colors.border}`, paddingLeft: 12 }}>
          <span style={{ color: colors.muted }}>{note.from} from the team:</span>
          <br />
          {note.text}
        </Text>
      )}
      <Button href={postUrl} style={buttonStyle(accent)}>
        See the idea
      </Button>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        You&apos;re getting this because you posted, voted, commented on or subscribed to it.{" "}
        <Link href={unsubscribeUrl} style={{ color: colors.muted, textDecoration: "underline" }}>
          Unsubscribe from {projectName}
        </Link>
      </Text>
    </Layout>
  );
}

export const statusEmail = (props: StatusProps) => ({
  subject: `${STATUSES[props.status].label}: ${props.postTitle}`,
  body: <StatusEmail {...props} />,
});
