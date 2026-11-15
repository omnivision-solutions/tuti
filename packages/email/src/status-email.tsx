import { Button, Column, Row, Section, Text } from "@react-email/components";

import { accentColors, buttonStyle, colors, type EmailBrand, FooterLink, Layout } from "./layout";

/**
 * The statuses a post's people hear about before it ships (Completed's is the shipped email), each as it reads, its pill
 * in the portal's hue (light mode's `status-*` in packages/ui/src/globals.css, as hex): the name in it, on 8% of it with a
 * 25% border, as the portal's StatusPill.
 */
const STATUSES = {
  PLANNED: { label: "Planned", is: "is planned", next: "The team plans to build it.", pill: { color: "#1467c2", background: "#ecf3fa", border: "#c4d9f0" } },
  IN_PROGRESS: { label: "In progress", is: "is in progress", next: "The team has started building it.", pill: { color: "#b14600", background: "#f9f0eb", border: "#ebd1bf" } },
} as const;

export type ProgressStatus = keyof typeof STATUSES;

/** `note`: the team's comment posted with the change, quoted under the news. */
type StatusProps = EmailBrand & {
  status: ProgressStatus;
  postTitle: string;
  boardName: string;
  votes: number;
  postUrl: string;
  unsubscribeUrl: string;
  note?: { from: string; text: string };
};

export function StatusEmail({ projectName, accent, poweredBy, status, postTitle, boardName, votes, postUrl, unsubscribeUrl, note }: StatusProps) {
  const { label, is, next, pill } = STATUSES[status];
  return (
    <Layout
      preview={`An idea you're following moved to ${label}`}
      project={{ projectName, accent, poweredBy }}
      footer={
        <>
          You&apos;re getting this because you posted, voted, commented on or subscribed to it.{" "}
          <FooterLink href={unsubscribeUrl}>Unsubscribe from {projectName}</FooterLink>
        </>
      }
    >
      <Text style={{ fontSize: 14, fontWeight: 600, color: accentColors(accent).link, margin: "16px 0 4px" }}>Update on an idea you asked for</Text>
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
            <Text style={{ margin: 0, fontSize: 12, fontWeight: 600, color: pill.color, backgroundColor: pill.background, border: `1px solid ${pill.border}`, borderRadius: 999, padding: "2px 10px" }}>
              ● {label}
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
    </Layout>
  );
}

export const statusEmail = (props: StatusProps) => ({
  subject: `${STATUSES[props.status].label}: ${props.postTitle}`,
  body: <StatusEmail {...props} />,
});
