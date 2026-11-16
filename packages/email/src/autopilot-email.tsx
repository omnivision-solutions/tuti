import { Column, Link, Row, Section, Text } from "@react-email/components";
import type { DiffLine } from "@tuti/content";
import { Fragment } from "react";

import { Buttons, colors, Diff, Eyebrow, FooterLink, Layout, Stats, textStyle, Title } from "./layout";

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
  /** One click for its recipient (signed in): approve it. And its post's or article's review, to edit first. */
  approveUrl?: string;
  editUrl?: string;
};

/** A merged pull request's updates: what goes out by itself, what needs the team, and what Autopilot did already. */
export type AutopilotEmailChange = {
  title: string;
  pullRequest: string;
  summary: string;
  /** Its activity page: every post and article it updates, each a link to its review. */
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

/** Each list's heading colour and icon, so a glance finds what needs them: orange waits for them, green goes out by itself, grey is done. */
const tones = {
  needsYou: { icon: "✋", color: colors.onHighlight },
  goesOut: { icon: "⏳", color: colors.onSoft },
  wentOut: { icon: "✅", color: colors.muted },
  done: { icon: "📝", color: colors.muted },
};
type List = keyof typeof tones;

/** An update's kind badge in the app's `kind-*` colours (TargetBadge): its text on a 15% tint of it, grey for the rest. */
const KIND_TONES: Record<string, { color: string; backgroundColor: string }> = {
  closes: { color: "#146d34", backgroundColor: "#dce9e1" },
  progress: { color: "#155aa7", backgroundColor: "#dce6f2" },
  edit: { color: "#7d5002", backgroundColor: "#ebe5d9" },
  neutral: { color: "#57534e", backgroundColor: "#f5f5f4" },
};
const KINDS: Record<string, keyof typeof KIND_TONES> = {
  "Completes the post": "closes",
  "New article": "closes",
  "Progress update": "progress",
  "Missing info": "edit",
  "Out of date": "edit",
};

function Kind({ kind }: { kind: string }) {
  return <span style={{ ...KIND_TONES[KINDS[kind] ?? "neutral"], fontSize: 12, fontWeight: 600, borderRadius: 6, padding: "2px 8px", whiteSpace: "nowrap" }}>{kind}</span>;
}

/**
 * One update, a bordered card: its kind and title, when it goes out and how sure Autopilot is, what it does, what it
 * changes (`shown`: what customers saw, or will), and its one-click buttons.
 */
function Update({ update, pullRequest, shown = true }: { update: AutopilotEmailUpdate; pullRequest?: string; shown?: boolean }) {
  return (
    <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ margin: "10px 0 0", borderCollapse: "separate" }}>
      <tbody>
        <tr>
          <td style={{ border: `1px solid ${colors.border}`, borderRadius: 12, padding: "14px 16px" }}>
            <Row>
              <Column style={{ verticalAlign: "top" }}>
                <Text style={{ fontSize: 14, lineHeight: "22px", color: colors.text, margin: 0 }}>
                  <Kind kind={update.kind} /> <strong>{update.title}</strong>
                </Text>
              </Column>
              {/* No fixed width: on a phone it wraps under its own words rather than push the card wider than the screen. */}
              <Column style={{ verticalAlign: "top", textAlign: "right", paddingLeft: 8 }}>
                {/* Apart from the title in plain text too. */}{" "}
                <Text style={{ fontSize: 13, lineHeight: "22px", color: colors.muted, margin: 0 }}>
                  {[update.goesOut, update.sure !== undefined && `${update.sure}% sure`].filter(Boolean).join(" · ")}
                </Text>
              </Column>
            </Row>
            <Text style={{ fontSize: 14, color: "#57534e", lineHeight: "20px", margin: "6px 0 0" }}>{[update.fact, pullRequest].filter(Boolean).join(" · ")}</Text>
            {shown && update.diff && update.diff.length > 0 && <Diff lines={update.diff} more={update.diffMore} />}
            {update.approveUrl ? (
              <Buttons small href={update.approveUrl} label="Approve" second={update.editUrl ? { href: update.editUrl, label: "Review first" } : undefined} />
            ) : (
              update.editUrl && (
                <Text style={{ fontSize: 14, margin: "10px 0 0" }}>
                  <Link href={update.editUrl} style={{ color: colors.green, fontWeight: 600 }}>
                    Review first →
                  </Link>
                </Text>
              )
            )}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** One list across every change, under its heading. What goes out by itself ends each change's with Publish now and Stop. */
function Group({ heading, list, changes }: { heading: string; list: List; changes: AutopilotEmailChange[] }) {
  if (changes.every((change) => change[list].length === 0)) {
    return null;
  }
  const tone = tones[list];
  return (
    <Section style={{ margin: "22px 0 0" }}>
      <Text style={{ fontSize: 14, fontWeight: 700, color: tone.color, margin: 0 }}>
        {tone.icon} {heading}
      </Text>
      {changes.map((change, i) => {
        const pullRequest = changes.length > 1 ? change.pullRequest : undefined;
        // Its buttons say which by number ("#418"), short enough not to wrap; the whole name when another repository's has that number too.
        const number = pullRequest?.slice(pullRequest.lastIndexOf("#"));
        const which = number && changes.some((other) => other !== change && other.pullRequest.endsWith(number)) ? pullRequest : number;
        return (
          <Fragment key={i}>
            {change[list].map((update, j) => (
              // What only the team sees is a line: the email is how they learn what customers saw.
              <Update key={j} update={update} pullRequest={pullRequest} shown={list !== "done"} />
            ))}
            {list === "goesOut" && change[list].length > 0 && change.publishUrl && change.stopUrl && (
              <Buttons
                href={change.publishUrl}
                label={which ? `Publish ${which} now` : "Publish now"}
                second={{ href: change.stopUrl, label: which ? `Stop ${which}` : "Stop" }}
              />
            )}
          </Fragment>
        );
      })}
    </Section>
  );
}

/** The overview: a tile per list with anything in it, its count over what it is ("3", "Need your approval"). */
function overview(totals: AutopilotProps["totals"], digest = false): { n: number; label: string }[] {
  return [
    { n: totals.needsYou, label: `${digest ? "Still need" : "Need"}${totals.needsYou === 1 ? "s" : ""} your approval` },
    // Each may go at its own time: the first's.
    { n: totals.goesOut, label: `Auto-updating${totals.goesOut === 1 ? "" : ", first"} ${totals.first}` },
    { n: totals.wentOut, label: "Published already" },
    { n: totals.done ?? 0, label: "Only your team sees" },
  ].filter((line) => line.n > 0);
}

/**
 * To the people told about a project's Autopilot (owners, and those the project adds): what its
 * merged pull requests change, what needs them, what goes out by itself and when, and what's done.
 */
export function AutopilotEmail({ projectName, changes, totals, digest, more, autopilotUrl, accountUrl }: AutopilotProps) {
  const merged = totals.pullRequests ?? changes.length;
  const one = merged === 1 ? changes[0] : undefined;
  return (
    <Layout
      preview={previewOf(changes)}
      label="Autopilot"
      footer={
        <>
          You&apos;re told about {projectName}&apos;s Autopilot. <FooterLink href={accountUrl}>Choose when you hear from it</FooterLink> (owners
          always hear what goes out by itself).
        </>
      }
    >
      <Eyebrow>
        {projectName} · {one ? one.pullRequest : plural(merged, "merged pull request", "merged pull requests")}
      </Eyebrow>
      <Title>{one ? one.title : sentence(headline(totals, digest))}</Title>
      {one?.summary && <Text style={{ ...textStyle, margin: "0 0 4px" }}>{one.summary}</Text>}
      {one && (
        <Text style={{ fontSize: 14, margin: "0 0 4px" }}>
          <Link href={one.reviewUrl} style={{ color: colors.green, fontWeight: 600 }}>
            Review in Tuti →
          </Link>
        </Text>
      )}
      <Stats items={overview(totals, digest)} />
      {!one &&
        changes.map((change, i) => (
          <Section key={i} style={{ borderBottom: "1px solid #f5f5f4", padding: "10px 0" }}>
            <Text style={{ fontSize: 15, fontWeight: 600, color: colors.text, lineHeight: "22px", margin: 0 }}>{change.title}</Text>
            {change.summary && <Text style={{ fontSize: 14, color: "#57534e", lineHeight: "21px", margin: "2px 0 0" }}>{change.summary}</Text>}
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
        <Text style={{ fontSize: 14, margin: "18px 0 0" }}>
          <Link href={autopilotUrl} style={{ color: colors.green, fontWeight: 600 }}>
            +{more} more in Tuti
          </Link>
        </Text>
      )}
    </Layout>
  );
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

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
