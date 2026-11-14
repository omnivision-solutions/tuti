import { ArrowRightIcon, CheckIcon, FileTextIcon, GitMergeIcon, GlobeIcon, MailIcon, MessageCircleIcon, SearchIcon, SparklesIcon } from "lucide-react";
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
  [11, "Booking pages", <Pill key="p" tone="plan">Planned</Pill>],
  [6, "Week numbers", <Pill key="p" tone="open">Open</Pill>],
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
    <Pic className="hero-sc sc-ib" label="The inbox: a customer's question answered by AI from the help center, then handed to a teammate, with the customer's details and the post it's linked to">
      <div className="sc-list">
        {[
          ["Ana Abbott", "Google Calendar sync", "2m"],
          ["Nico Lund", "Export to a spreadsheet?", "14m", true],
          ["Kira Kaur", "Seats on the annual plan", "1h"],
          ["Leo Park", "Invite a guest", "3h"],
          ["Sofia Ruiz", "Reminders arrive twice", "5h"],
          ["Tom Berg", "Thanks, all working now", "1d"],
        ].map(([name, subject, time, unread], n) => (
          <div key={name as string} className={n === 0 ? "on" : ""}>
            <b>
              {name}
              {unread && <i className="dot" />}
              <small>{time}</small>
            </b>
            <span>{subject}</span>
          </div>
        ))}
      </div>
      <div className="sc-conv">
        <Thread />
        <div className="sc-reply">
          Reply to Ana… <span className="sc-btn">Send</span>
        </div>
      </div>
      <div className="sc-who">
        <div className="p">
          <span>AA</span>
          <b>Ana Abbott</b>
          <small>ana@tidewater.co</small>
        </div>
        {[
          ["Company", "Tidewater"],
          ["Plan", "Team, 24 seats"],
          ["Assigned", "Maya"],
        ].map(([k, v]) => (
          <div key={k}>
            <small>{k}</small>
            <b>{v}</b>
          </div>
        ))}
        <div className="sc-card">
          <small>Linked post</small>
          <b>{REQUEST}</b>
          <Pill tone="prog">In progress</Pill>
        </div>
      </div>
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
      <Votes rows={6} />
    </Pic>
  );
}

export function HeroChangelog() {
  return (
    <Pic className="hero-sc sc-cl" label="A changelog: Two-way Google Calendar sync, new, and an improvement and a fix before it">
      <div className="sc-boardhead">
        <b>Changelog</b>
        <span className="sc-btn">Subscribe</span>
      </div>
      <Entry date="Today" />
      <Entry tag="Improved" date="Last week" title="Fewer duplicate reminders" line="Each reminder now goes out once, however many devices you use." />
      <Entry tag="Fixed" date="Oct 28" title="Time zones on shared events" line="Shared events now show in each guest's own time zone." />
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

function WidgetPanel() {
  return (
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
  );
}

const WIDGET = "The in-app widget: help search, popular articles, a message to the team and Share an idea";

export const CellWidget = () => (
  <Pic className="cell-sc sc-wdg" label={WIDGET}>
    <WidgetPanel />
  </Pic>
);

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

/** The roadmap page: each column's posts with their board (or, once shipped, the changelog) and votes. */
export function HeroRoadmap() {
  const columns: [string, string, [string, string, number][]][] = [
    [
      "Planned",
      "plan",
      [
        ["Dark mode", "Theme", 27],
        ["Recurring events", "Events", 18],
        ["Outlook sync", "Integrations", 15],
        ["Booking pages", "Sharing", 11],
        ["Week numbers", "Calendar", 6],
      ],
    ],
    [
      "In progress",
      "prog",
      [
        [REQUEST, "Integrations", 42],
        ["Shared calendars", "Teams", 31],
        ["Offline mode", "Apps", 14],
      ],
    ],
    [
      "Completed",
      "done",
      [
        ["Time zones", "In the changelog", 38],
        ["Keyboard shortcuts", "In the changelog", 22],
        ["Reminders by SMS", "In the changelog", 19],
        ["iCal export", "In the changelog", 9],
      ],
    ],
  ];
  return (
    <Pic className="hero-sc sc-rmh" label="A roadmap: five requests planned, three in progress with Google Calendar sync on top, four completed, each with its votes">
      <div className="sc-boardhead">
        <b>Roadmap</b>
        <span className="sc-btn">Share an idea</span>
      </div>
      <div className="cols">
        {columns.map(([name, tone, cards]) => (
          <div key={name} className="col">
            <small className={tone}>
              {name} <span>{cards.length}</span>
            </small>
            {cards.map(([title, meta, votes]) => (
              <div key={title} className="card">
                <b>{title}</b>
                <span>{meta}</span>
                <em>
                  {votes}
                  <small>votes</small>
                </em>
              </div>
            ))}
          </div>
        ))}
      </div>
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

export function CellAiTools() {
  return (
    <Pic className="cell-sc sc-mcp" label="An AI coding tool asked to fix the billing article: Tuti's articles_update tool updates it, ready to publish">
      <div className="tb">
        <i />
        <i />
        <i />
      </div>
      <p>
        <span className="p">›</span> Cancel moved to Settings → Plan. Fix the billing article.
      </p>
      <p className="m">tuti · articles_update “Cancel or change your plan”</p>
      <p>
        <span className="p">✓</span> Updated 2 steps. Ready to publish.
      </p>
    </Pic>
  );
}

// ---- The feature pages' (features/[slug]) ----

export function HeroAsk() {
  return (
    <Pic className="hero-sc sc-hc" label="A help center answering “How do I cancel my plan?” with AI, citing the article it came from, with Ask a person under it">
      <div className="brand">Lumen Help</div>
      <Answer wide />
      <div className="sc-ask">
        Still stuck? <span className="sc-btn ghost">Ask a person</span>
      </div>
    </Pic>
  );
}

export function HeroWidget() {
  return (
    <Pic className="hero-sc sc-hw" label={`An app with Tuti's widget open over it. ${WIDGET}`}>
      <div className="app" aria-hidden>
        <b>Calendar</b>
        <div className="wk">
          {(
            [
              ["Mon", [["9:00", "Standup"], ["11:30", "Design review"], ["15:00", "Hiring sync"]]],
              ["Tue", [["9:00", "Standup"], ["10:00", "Customer call"], ["14:00", "1:1 with Maya"], ["16:30", "Gym"]]],
              ["Wed", [["9:00", "Standup"], ["13:00", "Planning"], ["15:30", "Focus time"]]],
              ["Thu", [["9:00", "Standup"], ["11:00", "Demo day"], ["12:30", "Team lunch"], ["17:00", "Book club"]]],
              ["Fri", [["9:00", "Standup"], ["14:00", "Retro"], ["16:00", "Drinks"]]],
            ] as [string, [string, string][]][]
          ).map(([day, events]) => (
            <div key={day}>
              <small>{day}</small>
              {events.map(([time, name]) => (
                <i key={name}>
                  <small>{time}</small>
                  {name}
                </i>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="sc-wdg">
        <WidgetPanel />
      </div>
    </Pic>
  );
}

export function CellReview() {
  return (
    <Pic className="cell-sc" label={`Autopilot's update to “${ARTICLE}”, waiting with Approve and Dismiss`}>
      <div className="sc-card">
        <div className="h">
          <FileTextIcon {...i} /> {ARTICLE} <Pill tone="upd">Updated</Pill>
        </div>
        <Diff short />
        <div className="sc-acts">
          <span className="sc-btn">Approve</span>
          <span className="sc-btn ghost">Dismiss</span>
        </div>
      </div>
    </Pic>
  );
}

export const CellEmail = () => (
  <Pic className="cell-sc" label="An email reply from a customer, in the same conversation as their widget messages">
    <div className="sc-mail">
      <small>
        <MailIcon {...i} size={12} /> Email from Ana Abbott
      </small>
      <b>Re: Google Calendar sync</b>
      <span>That worked, thanks! Synced both ways now.</span>
    </div>
  </Pic>
);

export const CellInsert = () => (
  <Pic className="cell-sc sc-thread" label={`A teammate's reply with the help article “${ARTICLE}” in it`}>
    <small className="r">Maya · Lumen</small>
    <p className="tm">Here&apos;s how to connect it:</p>
    <span className="sc-src">
      <FileTextIcon {...i} size={12} /> {ARTICLE}
    </span>
  </Pic>
);

export const CellLinked = () => (
  <Pic className="cell-sc" label={`The feature request “${REQUEST}”: 42 votes and 6 conversations from the inbox linked to it`}>
    <div className="sc-card">
      <div className="h">
        <MessageCircleIcon {...i} /> {REQUEST} <Pill tone="prog">In progress</Pill>
      </div>
      <span className="sc-mute">42 votes · 6 conversations</span>
      <div className="sc-faces" aria-hidden>
        {["AA", "NL", "KK", "TO", "JR"].map((initials) => (
          <span key={initials}>{initials}</span>
        ))}
      </div>
    </div>
  </Pic>
);

export const CellDuplicate = () => (
  <Pic className="cell-sc" label={`A new post, “Sync my Google calendar”, flagged as a possible duplicate of “${REQUEST}”, with Merge`}>
    <div className="sc-card">
      <div className="h">
        <MessageCircleIcon {...i} /> Sync my Google calendar <Pill tone="prog">Possible duplicate</Pill>
      </div>
      <span className="sc-mute">Looks like “{REQUEST}”</span>
      <div className="sc-acts">
        <span className="sc-btn">Merge</span>
      </div>
    </div>
  </Pic>
);

export const CellImport = () => (
  <Pic className="cell-sc" label="128 articles imported from Intercom, each old link redirected to its new page">
    <div className="sc-card">
      <div className="sc-move">
        <Pill tone="open">Intercom</Pill>
        <ArrowRightIcon {...i} />
        <Pill tone="done">Lumen Help</Pill>
      </div>
      <span className="sc-mute">128 articles · old links redirect</span>
    </div>
  </Pic>
);

export const CellDomain = () => (
  <Pic className="cell-sc" label="The help center on help.lumen.app, connected">
    <div className="sc-search">
      <GlobeIcon {...i} size={15} /> help.lumen.app
      <Pill tone="done">
        <CheckIcon {...i} size={12} /> Connected
      </Pill>
    </div>
  </Pic>
);

export const CellSubscribe = () => (
  <Pic className="cell-sc" label={`A changelog email to subscribers: “${ENTRY}”`}>
    <div className="sc-mail">
      <small>
        <MailIcon {...i} size={12} /> To subscribers
      </small>
      <b>New: {ENTRY}</b>
      <span>Events you change in Google show up in Lumen.</span>
    </div>
  </Pic>
);

export const CellReactions = () => (
  <Pic className="cell-sc" label={`The changelog entry “${ENTRY}” with reactions: 24 thumbs up, 12 party poppers, 9 hearts`}>
    <Entry date="Today" />
    <div className="sc-react">
      {["👍 24", "🎉 12", "❤️ 9"].map((r) => (
        <span key={r}>{r}</span>
      ))}
    </div>
  </Pic>
);
