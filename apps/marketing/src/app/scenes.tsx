import { ArrowRightIcon, CheckIcon, FileTextIcon, GitMergeIcon, MailIcon, MessageCircleIcon, SearchIcon, SparklesIcon } from "lucide-react";
import type { ReactNode } from "react";

import { GithubMark } from "@tuti/ui/github-mark";

/*
 * The home page's pictures: one moment each, drawn in the product's style, not screenshots. They read at a glance and
 * reflow on a phone. One story throughout: the made-up company Lumen merges pull request #230, two-way Google Calendar
 * sync, and everything customers see follows it (landing.css, Scenes).
 */

const i = { "aria-hidden": true, size: 14 } as const;

/** A picture: what it shows is its label; what's inside is drawn for the eye only. */
function Pic({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div role="img" aria-label={label} className={`sc ${className ?? ""}`}>
      {children}
    </div>
  );
}

const Pill = ({ tone, children }: { tone: "prog" | "done" | "plan" | "open" | "upd"; children: ReactNode }) => <span className={`sc-pill ${tone}`}>{children}</span>;

const ARTICLE = "Sync with Google Calendar";
const REQUEST = "Google Calendar sync";
const ENTRY = "Two-way Google Calendar sync";

function Pr() {
  return (
    <div className="sc-pr">
      <div className="r">
        <GithubMark className="size-3.5" /> lumen / app
      </div>
      <div className="t">
        {ENTRY} <span>#230</span>
      </div>
      <span className="merged">
        <GitMergeIcon {...i} size={12} /> Merged
      </span>
      <div className="f">
        <span>
          sync/google.ts <b>+212</b> <em>−40</em>
        </span>
        <span>
          jobs/sync-calendars.ts <b>+91</b>
        </span>
      </div>
    </div>
  );
}

function Diff({ short }: { short?: boolean }) {
  return (
    <div className="sc-diff">
      <s>Import a calendar once, as a .ics file.</s>
      <ins>Connect Google in Settings → Integrations.</ins>
      {!short && <ins>Changes sync both ways, every few minutes.</ins>}
    </div>
  );
}

function Completed() {
  return (
    <div className="sc-done">
      <div className="sc-move">
        <Pill tone="prog">In progress</Pill>
        <ArrowRightIcon {...i} />
        <Pill tone="done">
          <CheckIcon {...i} size={12} /> Completed
        </Pill>
      </div>
      <div className="sc-mail">
        <small>
          <MailIcon {...i} size={12} /> To 42 voters
        </small>
        <b>It shipped: {REQUEST}</b>
        <span>You asked for it. Here&apos;s how to turn it on.</span>
      </div>
    </div>
  );
}

function Entry({ title = ENTRY, line = "Events you change in Google show up in Lumen, and the other way round.", tag = "New", date }: { title?: string; line?: string; tag?: string; date?: string }) {
  return (
    <div className="sc-entry">
      <div className="m">
        <Pill tone="open">{tag}</Pill>
        {date && <small>{date}</small>}
      </div>
      <b>{title}</b>
      <span>{line}</span>
    </div>
  );
}

function Answer({ wide }: { wide?: boolean }) {
  return (
    <div className={`sc-answer ${wide ? "wide" : ""}`}>
      <div className="sc-search">
        <SearchIcon {...i} size={wide ? 18 : 15} /> How do I cancel my plan?
      </div>
      <div className="sc-ai">
        <small>
          <SparklesIcon {...i} size={12} /> AI answer
        </small>
        <p>
          Open <b>Settings → Billing</b> and choose <b>Cancel plan</b>. You keep access until the end of the period you paid for.
        </p>
        <span className="sc-src">
          <FileTextIcon {...i} size={12} /> Cancel or change your plan
        </span>
      </div>
    </div>
  );
}

function Thread() {
  return (
    <div className="sc-thread">
      <small>Ana · Tidewater</small>
      <p className="cu">Do events I change in Google show up in Lumen?</p>
      <small className="r">
        <SparklesIcon {...i} size={11} /> AI answer
      </small>
      <p className="bot">
        Yes, both ways, every few minutes.
        <span className="sc-src">
          <FileTextIcon {...i} size={12} /> {ARTICLE}
        </span>
      </p>
      <small>Ana</small>
      <p className="cu">Our team calendar is stuck, though.</p>
      <div className="hand">Handed to Maya</div>
      <small className="r">Maya · Lumen</small>
      <p className="tm">On it. I&apos;ve reset the connection, try Connect once more.</p>
    </div>
  );
}

const POSTS: [number, string, ReactNode][] = [
  [42, REQUEST, <Pill key="p" tone="prog">In progress</Pill>],
  [27, "Dark mode", <Pill key="p" tone="plan">Planned</Pill>],
  [18, "Recurring events", <Pill key="p" tone="plan">Planned</Pill>],
  [12, "Export to a spreadsheet", <Pill key="p" tone="open">Open</Pill>],
];

function Votes({ rows = 3 }: { rows?: number }) {
  return (
    <div className="sc-votes">
      {POSTS.slice(0, rows).map(([votes, title, status], n) => (
        <div key={title} className="row">
          <span className={n === 0 ? "v on" : "v"}>
            {votes}
            <small>votes</small>
          </span>
          <b>{title}</b>
          {status}
        </div>
      ))}
    </div>
  );
}

const Tiles = () => (
  <div className="sc-tiles">
    {["Getting started", "Calendars and events", "Plans and billing"].map((name) => (
      <span key={name}>{name}</span>
    ))}
  </div>
);

// ---- The hero's window, one per tab ----

export function HeroAutopilot() {
  return (
    <Pic className="hero-sc sc-ap" label={`Pull request #230 merged, and from it: the article “${ARTICLE}” rewritten, the feature request “${REQUEST}” completed with its 42 voters emailed, and a changelog entry drafted`}>
      <Pr />
      <div className="sc-from">
        <small>From #230</small>
        <div className="sc-card">
          <div className="h">
            <FileTextIcon {...i} /> {ARTICLE} <Pill tone="upd">Updated</Pill>
          </div>
          <Diff />
        </div>
        <div className="sc-card">
          <div className="h">
            <MessageCircleIcon {...i} /> {REQUEST} <Pill tone="done">Completed</Pill>
          </div>
          <span className="sc-mute">42 voters emailed</span>
        </div>
        <div className="sc-card">
          <div className="h">
            <SparklesIcon {...i} /> {ENTRY} <Pill tone="open">Changelog draft</Pill>
          </div>
        </div>
      </div>
    </Pic>
  );
}

export function HeroHelp() {
  return (
    <Pic className="hero-sc sc-hc" label="A help center answering “How do I cancel my plan?” with AI, citing the article it came from">
      <div className="brand">Lumen Help</div>
      <Answer wide />
      <Tiles />
    </Pic>
  );
}

export function HeroInbox() {
  return (
    <Pic className="hero-sc sc-ib" label="The inbox: a customer's question answered by AI from the help center, then handed to a teammate">
      <div className="sc-list">
        {[
          ["Ana Abbott", "Google Calendar sync", true],
          ["Nico Lund", "Export to a spreadsheet?", false],
          ["Kira Kaur", "Seats on the annual plan", false],
        ].map(([name, subject, on]) => (
          <div key={name as string} className={on ? "on" : ""}>
            <b>{name}</b>
            <span>{subject}</span>
          </div>
        ))}
      </div>
      <Thread />
    </Pic>
  );
}

export function HeroFeedback() {
  return (
    <Pic className="hero-sc sc-fb" label="A feedback board: feature requests ranked by votes, Google Calendar sync on top with 42">
      <div className="sc-boardhead">
        <b>Feature requests</b>
        <span className="sc-btn">Share an idea</span>
      </div>
      <Votes rows={4} />
    </Pic>
  );
}

export function HeroChangelog() {
  return (
    <Pic className="hero-sc sc-cl" label="A changelog: Two-way Google Calendar sync, new, and an improvement before it">
      <Entry date="Today" />
      <Entry tag="Improved" date="Last week" title="Fewer duplicate reminders" line="Each reminder now goes out once, however many devices you use." />
    </Pic>
  );
}

// ---- Autopilot's steps ----

export function StepArticle() {
  return (
    <Pic className="step-sc" label={`The article “${ARTICLE}”: the old import step struck out, the new sync steps added`}>
      <div className="sc-title">
        <FileTextIcon {...i} /> {ARTICLE}
      </div>
      <Diff />
    </Pic>
  );
}

export function StepRequest() {
  return (
    <Pic className="step-sc" label={`The feature request “${REQUEST}” moved to Completed, and an email to its 42 voters`}>
      <div className="sc-title">
        <MessageCircleIcon {...i} /> {REQUEST}
      </div>
      <Completed />
    </Pic>
  );
}

export function StepChangelog() {
  return (
    <Pic className="step-sc" label={`A changelog entry drafted from #230: “${ENTRY}”, ready to publish`}>
      <div className="sc-title">
        <GithubMark className="size-3.5" /> From #230
      </div>
      <Entry />
      <span className="sc-btn">Publish</span>
    </Pic>
  );
}

// ---- The bento's cells ----

export const CellHelp = () => (
  <Pic className="cell-sc" label="An AI answer to “How do I cancel my plan?”, citing the article it came from, over the help center's collections">
    <Answer wide />
    <Tiles />
  </Pic>
);

export function CellWidget() {
  return (
    <Pic className="cell-sc sc-wdg" label="The in-app widget: help search, popular articles, a message to the team and Share an idea">
      <div className="w">
        <b>How can we help?</b>
        <div className="sc-search">
          <SearchIcon {...i} /> Search for help
        </div>
        <div className="lst">
          <span>
            <FileTextIcon {...i} /> {ARTICLE}
          </span>
          <span>
            <FileTextIcon {...i} /> Invite your team
          </span>
          <span>
            <MessageCircleIcon {...i} /> Send us a message
          </span>
          <span>
            <SparklesIcon {...i} /> Share an idea
          </span>
        </div>
      </div>
    </Pic>
  );
}

export const CellInbox = () => (
  <Pic className="cell-sc" label="A conversation: the customer asks, AI answers from the help center, then a teammate takes over">
    <Thread />
  </Pic>
);

export const CellFeedback = () => (
  <Pic className="cell-sc" label="Feature requests ranked by votes, Google Calendar sync on top with 42">
    <Votes rows={4} />
  </Pic>
);

export function CellRoadmap() {
  const columns: [string, string[]][] = [
    ["Planned", ["Dark mode", "Recurring events"]],
    ["In progress", [REQUEST]],
    ["Completed", ["Time zones", "Keyboard shortcuts"]],
  ];
  return (
    <Pic className="cell-sc sc-rm" label="A roadmap: Planned, In progress and Completed, with feature requests in each">
      {columns.map(([name, cards]) => (
        <div key={name}>
          <small>{name}</small>
          {cards.map((card) => (
            <span key={card}>{card}</span>
          ))}
        </div>
      ))}
    </Pic>
  );
}

export const CellChangelog = () => (
  <Pic className="cell-sc" label={`A changelog entry: “${ENTRY}”, new today`}>
    <Entry date="Today" />
  </Pic>
);

export function CellVerify() {
  return (
    <Pic className="cell-sc sc-ver" label="An article checked against the code: one step matches, another says every 15 minutes where the code now syncs every 5">
      <span>
        <CheckIcon {...i} /> Connect Google in Settings → Integrations.
      </span>
      <span className="bad">
        <b>!</b> Changes sync every 15 minutes.
        <em>Code says every 5 minutes</em>
      </span>
    </Pic>
  );
}

export function CellReporting() {
  const gaps: [string, number][] = [
    ["export to csv", 14],
    ["outlook calendar", 9],
    ["delete account", 6],
  ];
  return (
    <Pic className="cell-sc sc-rep" label="Searches that found nothing: export to csv 14 times, outlook calendar 9, delete account 6">
      <small>Searches that found nothing</small>
      {gaps.map(([query, count]) => (
        <div key={query}>
          <span>“{query}”</span>
          <span className="track">
            <i style={{ width: `${(count / gaps[0][1]) * 85}%` }} />
            <b>{count}</b>
          </span>
        </div>
      ))}
    </Pic>
  );
}
