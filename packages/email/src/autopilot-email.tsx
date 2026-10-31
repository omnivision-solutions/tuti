import { Button, Hr, Link, Section, Text } from "@react-email/components";

import { colors, Layout } from "./layout";

/** One update, as the email previews it. `goesOut`: when it goes out by itself ("in 24 hours", "now"). */
export type AutopilotEmailUpdate = {
  kind: string;
  title: string;
  fact: string;
  goesOut?: string;
  /** One click for its recipient (signed in): approve it. And its review page, with it ticked, to edit first. */
  approveUrl?: string;
  editUrl?: string;
};

/** A merged pull request's updates: what goes out by itself, what needs the team, and what Autopilot did already. */
export type AutopilotEmailChange = {
  title: string;
  pullRequest: string;
  summary: string;
  /** Its review page, with the likely updates ticked. */
  reviewUrl: string;
  /** One click for its recipient: what goes out by itself goes now, or waits for the team. */
  publishUrl?: string;
  stopUrl?: string;
  goesOut: AutopilotEmailUpdate[];
  /** What customers see that went out by itself already (a hold shorter than the wait for this email). */
  wentOut: AutopilotEmailUpdate[];
  needsYou: AutopilotEmailUpdate[];
  done: AutopilotEmailUpdate[];
};

type AutopilotProps = {
  projectName: string;
  changes: AutopilotEmailChange[];
  /** Every update going out by itself (and when the first goes) and needing the team, shown or not: the subject's counts. */
  totals: { goesOut: number; wentOut: number; needsYou: number; first: string };
  /** Updates past the first five, left out: "+N more in Tuti". */
  more: number;
  autopilotUrl: string;
  /** Where they choose Autopilot's email (their account). */
  accountUrl: string;
};

const button = { backgroundColor: colors.green, color: colors.onGreen, borderRadius: 10, padding: "10px 16px", fontSize: 14, fontWeight: 600 };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Updates({ heading, updates }: { heading: string; updates: AutopilotEmailUpdate[] }) {
  if (updates.length === 0) {
    return null;
  }
  return (
    <>
      <Text style={{ fontSize: 12, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase", color: colors.muted, margin: "16px 0 4px" }}>{heading}</Text>
      {updates.map((update, i) => (
        <Text key={i} style={{ fontSize: 14, color: colors.text, lineHeight: "21px", margin: "0 0 8px" }}>
          <span style={{ color: colors.muted }}>{update.kind} · </span>
          <strong>{update.title}</strong>
          <br />
          <span style={{ color: colors.muted }}>
            {update.fact}
            {update.goesOut && ` · goes out ${update.goesOut}`}
          </span>
          {(update.approveUrl || update.editUrl) && (
            <>
              <br />
              {update.approveUrl && (
                <Link href={update.approveUrl} style={{ color: colors.green, fontWeight: 600 }}>
                  Approve
                </Link>
              )}
              {update.approveUrl && update.editUrl && " · "}
              {update.editUrl && (
                <Link href={update.editUrl} style={{ color: colors.green }}>
                  Edit
                </Link>
              )}
            </>
          )}
        </Text>
      ))}
    </>
  );
}

/**
 * To the people told about a project's Autopilot (owners, and those the project adds): what its
 * merged pull requests change, what goes out by itself and when, what needs them, and what's done.
 */
export function AutopilotEmail({ projectName, changes, totals, more, autopilotUrl, accountUrl }: AutopilotProps) {
  return (
    <Layout preview={subjectOf(changes, totals)}>
      {changes.map((change, i) => (
        <Section key={i}>
          {i > 0 && <Hr style={{ borderColor: colors.border, margin: "16px 0" }} />}
          <Text style={{ fontSize: 16, fontWeight: 700, color: colors.text, margin: "16px 0 4px" }}>{change.title}</Text>
          <Text style={{ fontSize: 13, color: colors.muted, margin: "0 0 8px" }}>{change.pullRequest}</Text>
          {change.summary && <Text style={{ fontSize: 14, color: colors.text, lineHeight: "21px", margin: "0 0 8px" }}>{change.summary}</Text>}
          <Updates heading="Goes out by itself" updates={change.goesOut} />
          {change.publishUrl && change.stopUrl && (
            <Text style={{ fontSize: 14, margin: "0 0 8px" }}>
              <Link href={change.publishUrl} style={{ color: colors.green, fontWeight: 600 }}>
                Publish now
              </Link>
              {" · "}
              <Link href={change.reviewUrl} style={{ color: colors.green }}>
                Review
              </Link>
              {" · "}
              <Link href={change.stopUrl} style={{ color: colors.green }}>
                Stop
              </Link>
            </Text>
          )}
          <Updates heading="Went out by itself" updates={change.wentOut} />
          <Updates heading="Needs you" updates={change.needsYou} />
          <Updates heading="Done (only your team sees it)" updates={change.done} />
          <Button href={change.reviewUrl} style={button}>
            Review
          </Button>
        </Section>
      ))}
      {more > 0 && (
        <Text style={{ fontSize: 14, color: colors.text, marginTop: 16 }}>
          <Link href={autopilotUrl} style={{ color: colors.green }}>
            +{more} more in Tuti
          </Link>
        </Text>
      )}
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        You&apos;re told about {projectName}&apos;s Autopilot.{" "}
        <Link href={accountUrl} style={{ color: colors.muted, textDecoration: "underline" }}>
          Choose when you hear from it
        </Link>
        {" "}(owners always hear what goes out by itself).
      </Text>
    </Layout>
  );
}

/** "Autopilot: Add a dark theme · 2 updates go out in 24 hours, 1 needs you"; for several, how many merged. */
function subjectOf(changes: AutopilotEmailChange[], totals: AutopilotProps["totals"]): string {
  const parts = [
    totals.wentOut > 0 && `${plural(totals.wentOut, "update", "updates")} went out`,
    totals.goesOut > 0 && `${plural(totals.goesOut, "update goes", "updates go")} out ${totals.first}`,
    totals.needsYou > 0 && `${totals.needsYou} ${totals.needsYou === 1 ? "needs" : "need"} you`,
  ].filter(Boolean);
  const what = changes.length === 1 ? changes[0]!.title : `${changes.length} merged pull requests`;
  return `Autopilot: ${what}${parts.length > 0 ? ` · ${parts.join(", ")}` : ""}`;
}

export const autopilotEmail = (props: AutopilotProps) => ({
  subject: subjectOf(props.changes, props.totals),
  body: <AutopilotEmail {...props} />,
});
