import { Button, Link, Section, Text } from "@react-email/components";
import type { DiffLine } from "@tuti/content";
import type { ReactNode } from "react";

import { colors, Layout } from "./layout";

/** One update, as the email previews it. `goesOut`: when it goes out by itself ("in 24 hours", "now"). */
export type AutopilotEmailUpdate = {
  kind: string;
  title: string;
  fact: string;
  /** What it changes, line by line: an edit's changed paragraphs, the comment it posts, the changelog line it writes. */
  diff?: DiffLine[];
  /** Lines of it the email leaves out: "N more lines in Tuti". */
  diffMore?: number;
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
  /** Every update going out by itself (and when the first goes), needing the team and done, shown or not: the subject's counts. */
  totals: { goesOut: number; wentOut: number; needsYou: number; done?: number; first: string; pullRequests?: number };
  /** The morning's digest: what's still waiting. */
  digest?: boolean;
  /** Updates past the first five, left out: "+N more in Tuti". */
  more: number;
  autopilotUrl: string;
  /** Where they choose Autopilot's email (their account). */
  accountUrl: string;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Each list's colour, so a glance finds what needs them: amber waits for them, green goes out by itself, grey is done. */
const tones = {
  needsYou: { color: colors.onHighlight, background: colors.highlight },
  goesOut: { color: colors.green, background: colors.soft },
  done: { color: colors.muted, background: colors.mutedBackground },
};
type Tone = (typeof tones)[keyof typeof tones];

const primary = { backgroundColor: colors.green, color: colors.onGreen, borderRadius: 8, padding: "8px 14px", fontSize: 14, fontWeight: 600 };
const secondary = { ...primary, backgroundColor: colors.card, color: colors.green, border: `1px solid ${colors.border}`, padding: "7px 13px" };

/** An edit as its lines: removed ones struck through in red, added ones in green, each with its sign (for plain text too). */
function Diff({ lines }: { lines: DiffLine[] }) {
  const looks = {
    removed: { sign: "−", color: colors.destructive, background: colors.destructiveSoft, border: colors.destructive },
    added: { sign: "+", color: colors.onSoft, background: colors.soft, border: colors.green },
    same: { sign: " ", color: colors.muted, background: colors.card, border: colors.border },
  };
  return (
    <Section style={{ margin: "8px 0 0" }}>
      {lines.map((line, i) => {
        const look = looks[line.kind];
        return (
          <Text
            key={i}
            style={{ fontSize: 13, lineHeight: "19px", color: look.color, backgroundColor: look.background, borderLeft: `3px solid ${look.border}`, padding: "4px 8px", margin: "0 0 2px" }}
          >
            <strong>{look.sign} </strong>
            <span style={line.kind === "removed" ? { textDecoration: "line-through" } : undefined}>{line.text}</span>
          </Text>
        );
      })}
    </Section>
  );
}

function Updates({ heading, tone, updates, children }: { heading: string; tone: Tone; updates: AutopilotEmailUpdate[]; children?: ReactNode }) {
  if (updates.length === 0) {
    return null;
  }
  return (
    <Section style={{ margin: "16px 0 0" }}>
      <Text style={{ margin: "0 0 8px" }}>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: tone.color, backgroundColor: tone.background, borderRadius: 6, padding: "3px 8px" }}>
          {heading} · {updates.length}
        </span>
      </Text>
      {updates.map((update, i) => (
        <Section key={i} style={{ border: `1px solid ${colors.border}`, borderLeft: `3px solid ${tone.color}`, borderRadius: 8, padding: "10px 12px", margin: "0 0 8px" }}>
          <Text style={{ fontSize: 12, color: colors.muted, margin: 0 }}>{update.kind}</Text>
          <Text style={{ fontSize: 15, fontWeight: 600, color: colors.text, lineHeight: "21px", margin: "2px 0 0" }}>{update.title}</Text>
          <Text style={{ fontSize: 14, color: colors.text, lineHeight: "20px", margin: "2px 0 0" }}>
            {update.fact}
            {update.goesOut && <span style={{ color: tone.color, fontWeight: 600 }}> · goes out {update.goesOut}</span>}
          </Text>
          {update.diff && update.diff.length > 0 && <Diff lines={update.diff} />}
          {!!update.diffMore && (
            <Text style={{ fontSize: 13, color: colors.muted, margin: "4px 0 0" }}>{plural(update.diffMore, "more line", "more lines")} in Tuti</Text>
          )}
          {(update.approveUrl || update.editUrl) && (
            <Section style={{ margin: "10px 0 0" }}>
              {update.approveUrl && (
                <Button href={update.approveUrl} style={{ ...primary, marginRight: 4 }}>
                  Approve
                </Button>
              )}
              {/* Apart in plain text too, so each link stays whole. */}{" "}
              {update.editUrl && (
                <Button href={update.editUrl} style={secondary}>
                  Edit
                </Button>
              )}
            </Section>
          )}
        </Section>
      ))}
      {children}
    </Section>
  );
}

/**
 * To the people told about a project's Autopilot (owners, and those the project adds): what its
 * merged pull requests change, what needs them, what goes out by itself and when, and what's done.
 */
export function AutopilotEmail({ projectName, changes, totals, digest, more, autopilotUrl, accountUrl }: AutopilotProps) {
  return (
    <Layout preview={previewOf(changes)}>
      <Text style={{ fontSize: 20, fontWeight: 700, color: colors.text, lineHeight: "26px", margin: "16px 0 2px" }}>{headline(totals, digest)}</Text>
      <Text style={{ fontSize: 13, color: colors.muted, margin: "0 0 8px" }}>
        {projectName} · {plural(totals.pullRequests ?? changes.length, "merged pull request", "merged pull requests")}
      </Text>
      {changes.map((change, i) => (
        <Section key={i} style={{ borderTop: `1px solid ${colors.border}`, marginTop: 16 }}>
          <Text style={{ fontSize: 16, fontWeight: 700, color: colors.text, lineHeight: "22px", margin: "16px 0 2px" }}>{change.title}</Text>
          <Text style={{ fontSize: 13, color: colors.muted, margin: "0 0 6px" }}>{change.pullRequest}</Text>
          {change.summary && <Text style={{ fontSize: 14, color: colors.text, lineHeight: "21px", margin: 0 }}>{change.summary}</Text>}
          <Updates heading="Needs you" tone={tones.needsYou} updates={change.needsYou} />
          <Updates heading="Goes out by itself" tone={tones.goesOut} updates={change.goesOut}>
            {change.publishUrl && change.stopUrl && (
              <Section style={{ margin: "2px 0 0" }}>
                <Button href={change.publishUrl} style={{ ...primary, marginRight: 4 }}>
                  Publish now
                </Button>{" "}
                <Button href={change.stopUrl} style={secondary}>
                  Stop
                </Button>
              </Section>
            )}
          </Updates>
          <Updates heading="Went out by itself" tone={tones.done} updates={change.wentOut} />
          <Updates heading="Done (only your team sees it)" tone={tones.done} updates={change.done} />
          <Text style={{ fontSize: 14, margin: "12px 0 0" }}>
            <Link href={change.reviewUrl} style={{ color: colors.green, fontWeight: 600 }}>
              Review in Tuti →
            </Link>
          </Text>
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

/** What needs them first, then what goes out by itself and what went: "1 needs you, 2 go out in 24 hours". */
function headline(totals: AutopilotProps["totals"], digest = false): string {
  if (digest) {
    return `${totals.needsYou} still ${totals.needsYou === 1 ? "needs" : "need"} you`;
  }
  const parts = [
    totals.needsYou > 0 && `${totals.needsYou} ${totals.needsYou === 1 ? "needs" : "need"} you`,
    totals.goesOut > 0 && `${totals.goesOut} ${totals.goesOut === 1 ? "goes" : "go"} out ${totals.first}`,
    totals.wentOut > 0 && `${totals.wentOut} went out`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : `${totals.done ?? 0} done for your team`;
}

/** "1 needs you, 2 go out in 24 hours · Add a dark theme" (the sender says it's Autopilot); for several, how many merged. */
function subjectOf(changes: AutopilotEmailChange[], totals: AutopilotProps["totals"], digest = false): string {
  const merged = totals.pullRequests ?? changes.length;
  return `${headline(totals, digest)} · ${merged === 1 ? changes[0]!.title : `${merged} pull requests`}`;
}

/** The inbox's line under the subject: which updates, by name, then what shipped (or which pull requests). */
function previewOf(changes: AutopilotEmailChange[]): string {
  const named = (heading: string, updates: AutopilotEmailUpdate[]) =>
    updates.length > 0 && `${heading}: ${updates.map((update) => `${update.title} (${update.kind.toLowerCase()})`).join(", ")}.`;
  const goesOut = changes.flatMap((change) => change.goesOut);
  return [
    named("Needs you", changes.flatMap((change) => change.needsYou)),
    // By when each goes ("now" for a draft, "in 24 hours" after the hold).
    ...[...new Set(goesOut.map((update) => update.goesOut))].map((when) => named(`Goes out ${when}`, goesOut.filter((update) => update.goesOut === when))),
    named("Went out", changes.flatMap((change) => change.wentOut)),
    named("Done", changes.flatMap((change) => change.done)),
    changes.length === 1 ? changes[0]!.summary : changes.map((change) => change.title).join(" · "),
  ]
    .filter(Boolean)
    .join(" ");
}

export const autopilotEmail = (props: AutopilotProps) => ({
  fromName: "Tuti Autopilot",
  subject: subjectOf(props.changes, props.totals, props.digest),
  body: <AutopilotEmail {...props} />,
});
