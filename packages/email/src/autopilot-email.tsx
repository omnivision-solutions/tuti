import { Button, Column, Link, Row, Section, Text } from "@react-email/components";
import type { DiffLine } from "@tuti/content";
import { Fragment } from "react";

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
  /** How sure Autopilot is that it's right, in percent: none for what isn't its guess (a changelog line). */
  sure?: number;
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

/** Each list's colour and icon, so a glance finds what needs them: amber waits for them, green goes out by itself, grey is done. */
const tones = {
  needsYou: { icon: "✋", color: colors.onHighlight, background: colors.highlight },
  goesOut: { icon: "⏳", color: colors.onSoft, background: colors.soft },
  wentOut: { icon: "✅", color: colors.muted, background: colors.mutedBackground },
  done: { icon: "📝", color: colors.muted, background: colors.mutedBackground },
};
type List = keyof typeof tones;

const primary = { backgroundColor: colors.green, color: colors.onGreen, borderRadius: 8, padding: "8px 14px", fontSize: 14, fontWeight: 600 };
const secondary = { ...primary, backgroundColor: colors.card, color: colors.green, border: `1px solid ${colors.border}`, padding: "7px 13px" };

/** An edit as its lines: removed ones struck through in red, added ones in green, each with its sign (for plain text too). */
function Diff({ lines }: { lines: DiffLine[] }) {
  const looks = {
    removed: { sign: "−", color: colors.destructive, background: colors.destructiveSoft },
    added: { sign: "+", color: colors.onSoft, background: colors.soft },
    same: { sign: " ", color: colors.muted, background: colors.card },
  };
  return (
    <Section style={{ margin: "6px 0 0" }}>
      {lines.map((line, i) => {
        const look = looks[line.kind];
        return (
          <Text key={i} style={{ fontSize: 13, lineHeight: "19px", color: look.color, backgroundColor: look.background, borderRadius: 4, padding: "3px 8px", margin: "0 0 2px" }}>
            <strong>{look.sign} </strong>
            <span style={line.kind === "removed" ? { textDecoration: "line-through" } : undefined}>{line.text}</span>
          </Text>
        );
      })}
    </Section>
  );
}

/** "92% sure", as a chip: how sure Autopilot is. */
const Sure = ({ update }: { update: AutopilotEmailUpdate }) =>
  update.sure === undefined ? null : (
    <span style={{ fontSize: 12, fontWeight: 700, color: colors.muted, backgroundColor: colors.mutedBackground, borderRadius: 10, padding: "2px 7px", whiteSpace: "nowrap" }}>
      {update.sure}% sure
    </span>
  );

/** One update to act on (or to stop): its title and how sure, what kind and what it does, what it changes, and its buttons. */
function Update({ update, pullRequest }: { update: AutopilotEmailUpdate; pullRequest?: string }) {
  return (
    <Section style={{ borderBottom: `1px solid ${colors.border}`, padding: "10px 2px" }}>
      <Row>
        <Column style={{ verticalAlign: "top" }}>
          <Text style={{ fontSize: 15, fontWeight: 600, color: colors.text, lineHeight: "21px", margin: 0 }}>{update.title}</Text>
        </Column>
        <Column style={{ verticalAlign: "top", textAlign: "right", width: 80 }}>
          {/* Apart from the title in plain text too. */}{" "}
          <Sure update={update} />
        </Column>
      </Row>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "19px", margin: "1px 0 0" }}>
        {[update.kind, update.fact, pullRequest].filter(Boolean).join(" · ")}
        {update.goesOut && <span style={{ color: tones.goesOut.color, fontWeight: 600 }}> · goes out {update.goesOut}</span>}
      </Text>
      {update.diff && update.diff.length > 0 && <Diff lines={update.diff} />}
      {!!update.diffMore && <Text style={{ fontSize: 13, color: colors.muted, margin: "4px 0 0" }}>{plural(update.diffMore, "more line", "more lines")} in Tuti</Text>}
      {(update.approveUrl || update.editUrl) && (
        <Section style={{ margin: "8px 0 0" }}>
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
  );
}

/**
 * One update Autopilot did by itself, a line: its title, what it did, and how sure. What customers see (`shown`)
 * shows what it changed too: the email is how the team learns what went out without them.
 */
function Done({ update, pullRequest, shown }: { update: AutopilotEmailUpdate; pullRequest?: string; shown: boolean }) {
  const fact = update.fact.charAt(0).toLowerCase() + update.fact.slice(1);
  return (
    <Section style={{ borderBottom: `1px solid ${colors.border}`, padding: "7px 2px" }}>
      <Text style={{ fontSize: 14, color: colors.text, lineHeight: "20px", margin: 0 }}>
        <strong>{update.title}</strong>
        <span style={{ fontSize: 13, color: colors.muted }}> · {[fact, update.sure !== undefined && `${update.sure}% sure`, pullRequest].filter(Boolean).join(" · ")}</span>
      </Text>
      {shown && update.diff && update.diff.length > 0 && <Diff lines={update.diff} />}
      {shown && !!update.diffMore && <Text style={{ fontSize: 13, color: colors.muted, margin: "4px 0 0" }}>{plural(update.diffMore, "more line", "more lines")} in Tuti</Text>}
    </Section>
  );
}

/**
 * One list across every change, under its tinted band: what to act on in full, what Autopilot did a line each.
 * What goes out by itself ends each change's with Publish now and Stop.
 */
function Group({ heading, list, changes }: { heading: string; list: List; changes: AutopilotEmailChange[] }) {
  if (changes.every((change) => change[list].length === 0)) {
    return null;
  }
  const tone = tones[list];
  return (
    <Section style={{ margin: "18px 0 0" }}>
      <Text style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: tone.color, backgroundColor: tone.background, borderRadius: 8, padding: "7px 10px", margin: "0 0 2px" }}>
        {tone.icon} {heading}
      </Text>
      {changes.map((change, i) => {
        const pullRequest = changes.length > 1 ? change.pullRequest : undefined;
        return (
          <Fragment key={i}>
            {change[list].map((update, j) =>
              list === "wentOut" || list === "done" ? (
                <Done key={j} update={update} pullRequest={pullRequest} shown={list === "wentOut"} />
              ) : (
                <Update key={j} update={update} pullRequest={pullRequest} />
              ),
            )}
            {list === "goesOut" && change[list].length > 0 && change.publishUrl && change.stopUrl && (
              <Section style={{ margin: "8px 0 4px" }}>
                {/* Several changes: which one's they are. */}
                <Button href={change.publishUrl} style={{ ...primary, marginRight: 4 }}>
                  {pullRequest ? `Publish ${pullRequest} now` : "Publish now"}
                </Button>{" "}
                <Button href={change.stopUrl} style={secondary}>
                  {pullRequest ? `Stop ${pullRequest}` : "Stop"}
                </Button>
              </Section>
            )}
          </Fragment>
        );
      })}
    </Section>
  );
}

/** The overview: a coloured tile per list with anything in it, its count over what it is ("3", "Need your approval"). */
function overview(totals: AutopilotProps["totals"], digest = false): { list: List; n: number; text: string }[] {
  const lines: { list: List; n: number; text: string }[] = [
    { list: "needsYou", n: totals.needsYou, text: `${digest ? "Still need" : "Need"}${totals.needsYou === 1 ? "s" : ""} your approval` },
    // Each may go at its own time: the first's.
    { list: "goesOut", n: totals.goesOut, text: `Auto-updating${totals.goesOut === 1 ? "" : ", first"} ${totals.first}` },
    { list: "wentOut", n: totals.wentOut, text: "Published already" },
    { list: "done", n: totals.done ?? 0, text: "Only your team sees" },
  ];
  return lines.filter((line) => line.n > 0);
}

/**
 * To the people told about a project's Autopilot (owners, and those the project adds): what its
 * merged pull requests change, what needs them, what goes out by itself and when, and what's done.
 */
export function AutopilotEmail({ projectName, changes, totals, digest, more, autopilotUrl, accountUrl }: AutopilotProps) {
  return (
    <Layout preview={previewOf(changes)} label="Autopilot">
      <Text style={{ fontSize: 13, color: colors.muted, margin: "14px 0 8px" }}>
        {projectName} · {plural(totals.pullRequests ?? changes.length, "merged pull request", "merged pull requests")}
      </Text>
      {/* Tiles 4px apart: the table's own spacing (cells take no margin in email). */}
      <Row style={{ borderCollapse: "separate", borderSpacing: "4px 0" }}>
        {overview(totals, digest).map((line, _, lines) => (
          <Column
            key={line.list}
            style={{ color: tones[line.list].color, backgroundColor: tones[line.list].background, borderRadius: 10, padding: "8px 8px 7px", verticalAlign: "top", width: `${100 / lines.length}%` }}
          >
            {/* One line in plain text: "✋ 3 Need your approval". */}
            <Text style={{ fontSize: 12, fontWeight: 600, lineHeight: "15px", margin: 0 }}>
              <span style={{ display: "block", fontSize: 13, lineHeight: "16px" }}>{tones[line.list].icon}</span>{" "}
              <span style={{ display: "block", fontSize: 22, fontWeight: 800, lineHeight: "26px" }}>{line.n}</span> {line.text}
            </Text>
          </Column>
        ))}
      </Row>
      {changes.map((change, i) => (
        <Section key={i} style={{ margin: "16px 0 0" }}>
          <Text style={{ fontSize: 16, fontWeight: 700, color: colors.text, lineHeight: "22px", margin: 0 }}>{change.title}</Text>
          {change.summary && <Text style={{ fontSize: 14, color: colors.text, lineHeight: "21px", margin: "2px 0 0" }}>{change.summary}</Text>}
          <Text style={{ fontSize: 13, color: colors.muted, margin: "2px 0 0" }}>
            {change.pullRequest} ·{" "}
            <Link href={change.reviewUrl} style={{ color: colors.green, fontWeight: 600 }}>
              Review in Tuti →
            </Link>
          </Text>
        </Section>
      ))}
      <Group heading="Needs your approval" list="needsYou" changes={changes} />
      <Group heading="Auto-updating" list="goesOut" changes={changes} />
      <Group heading="Published already" list="wentOut" changes={changes} />
      <Group heading="Only your team sees" list="done" changes={changes} />
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
