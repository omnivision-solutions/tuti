import { creditsEnabled, freeCredits, plansEnabled } from "@tuti/shared";
import {
  ArrowRightIcon,
  BookOpenIcon,
  ChartColumnIcon,
  CheckIcon,
  ChevronUpIcon,
  FileTextIcon,
  GitMergeIcon,
  GlobeIcon,
  HandIcon,
  HomeIcon,
  InboxIcon,
  LightbulbIcon,
  MailIcon,
  MegaphoneIcon,
  MessageCircleIcon,
  PaletteIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  UserIcon,
  ZapIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { GithubMark } from "@/components/github-mark";
import { TutiMark } from "@/components/tuti-logo";

import { HeroTabs } from "./hero-tabs";
import "./landing.css";

/**
 * The home page (page.tsx; look in landing.css): the promise, a window onto each part of Tuti, then a section each for
 * the help center, the inbox, feedback, the widget and Autopilot, switching, pricing and questions. Copy is short and
 * unqualified: plan details live on /pricing (docs/design.md, Marketing copy). The mock UIs only show what's shipped.
 */

/** Where the page's links go: `start` the app when signed in, else sign-up; `docs` Tuti's own help center, when it has one. */
type Links = { start: string; docs: string | null };

function Start({ start, ghost = false, arrow = true }: { start: string; ghost?: boolean; arrow?: boolean }) {
  return (
    <Link href={start} className={ghost ? "btn btn-s" : "btn btn-p"}>
      {start === "/app" ? "Open app" : "Start free"}
      {arrow && <ArrowRightIcon aria-hidden size={16} />}
    </Link>
  );
}

function Ctas({ start, docs }: Links) {
  return (
    <div className="ctas">
      <Start start={start} />
      {docs && (
        <a className="btn btn-s" href={docs}>
          See a live help center
        </a>
      )}
    </div>
  );
}

export function Landing({ start, docs }: Links) {
  return (
    <div data-full className="lp">
      <Hero start={start} docs={docs} />
      <HelpCenter />
      <Inbox />
      <Feedback />
      <Widget />
      <Autopilot />
      <Switch />
      {plansEnabled() && <Pricing start={start} />}
      <Faq />
      <Final start={start} docs={docs} />
    </div>
  );
}

const icon = { "aria-hidden": true, size: 16 } as const;

function Hero({ start, docs }: Links) {
  return (
    <header className="hero">
      <div className="wrap">
        <h1>
          The help center that stays <em>in sync with your&nbsp;code.</em>
        </h1>
        <p className="lead">AI answers, an inbox and a feedback board. One tool, free to start.</p>
        <Ctas start={start} docs={docs} />
        <HeroTabs
          panels={[
            { label: "Help center", icon: <BookOpenIcon {...icon} />, url: "help.lumen.app", picture: <HelpPanel /> },
            { label: "Inbox", icon: <InboxIcon {...icon} />, url: "tuti.so/app/lumen/inbox", picture: <InboxPanel /> },
            { label: "Feedback", icon: <LightbulbIcon {...icon} />, url: "feedback.lumen.app", picture: <FeedbackPanel /> },
            { label: "Changelog", icon: <MegaphoneIcon {...icon} />, url: "help.lumen.app/changelog", picture: <ChangelogPanel /> },
            { label: "Autopilot", icon: <ZapIcon {...icon} />, url: "tuti.so/app/lumen/autopilot", picture: <AutopilotPanel /> },
          ]}
        />
      </div>
    </header>
  );
}

const Cite = ({ n }: { n: number }) => <span className="cite">{n}</span>;
const Face = ({ who, color }: { who: string; color: string }) => (
  <span className="av" style={{ background: color }}>
    {who}
  </span>
);
const FACES = [
  ["P", "#e07a5f"],
  ["T", "#3d85c6"],
  ["A", "#8e7cc3"],
  ["K", "#6aa84f"],
] as const;
function Faces({ children }: { children: ReactNode }) {
  return (
    <div className="faces">
      {FACES.map(([who, color]) => (
        <Face key={who} who={who} color={color} />
      ))}
      <b>{children}</b>
    </div>
  );
}
const Tag = ({ kind, children }: { kind: "done" | "prog" | "plan" | "rev"; children: ReactNode }) => <span className={`tag t-${kind}`}>{children}</span>;
const Diff = () => (
  <div className="diff">
    <s>Lumen comes in a light theme.</s>
    <br />
    <ins>Pick Light, Dark or System.</ins>
  </div>
);

function HelpPanel() {
  const groups = [
    ["Get started", ["Quickstart", "Invite your team", "Import your data"]],
    ["Workspaces", ["Pages and folders", "Sharing", "Export to PDF", "Large exports"]],
    ["Billing", ["Plans", "Invoices"]],
  ] as const;
  return (
    <div className="ui panel p-help" role="img" aria-label="A help center answering a question with AI, citing two articles">
      <div className="hc-top">
        <div className="brand">
          <i />
          Lumen Help
        </div>
        <div className="nv">
          <span>Changelog</span>
          <span>Feedback</span>
          <b>Contact us</b>
        </div>
      </div>
      <aside className="sb">
        {groups.map(([group, articles]) => (
          <div className="grp" key={group}>
            <div className="cap">{group}</div>
            {articles.map((a) => (
              <div key={a} className={a === "Export to PDF" ? "it on" : "it"}>
                <FileTextIcon aria-hidden size={14} />
                {a}
              </div>
            ))}
          </div>
        ))}
      </aside>
      <div className="hc-main">
        <div className="ask">
          <SparklesIcon aria-hidden size={16} />
          Can I export a whole workspace to PDF?<kbd>Ask AI</kbd>
        </div>
        <div className="ans">
          <div className="lbl">
            <SparklesIcon aria-hidden size={14} />
            AI answer
          </div>
          <p>
            Yes. Open <b>Settings → Workspace → Export</b> and choose PDF. Each page becomes a chapter, with comments left out
            <Cite n={1} />. Very large workspaces arrive by email as a single file
            <Cite n={2} />.
          </p>
          <div className="srcs">
            <span className="src">
              <Cite n={1} />
              Export to PDF
            </span>
            <span className="src">
              <Cite n={2} />
              Large exports
            </span>
          </div>
          <div className="fb">
            <span>Did this help?</span>
            <span className="chip">Yes</span>
            <span className="chip">No</span>
            <span className="push">Ask a person →</span>
          </div>
        </div>
        <div className="cols">
          <div className="col">
            <ZapIcon aria-hidden size={18} />
            <div className="h">Get started</div>
            <div className="mut">12 articles</div>
          </div>
          <div className="col">
            <FileTextIcon aria-hidden size={18} />
            <div className="h">Workspaces</div>
            <div className="mut">18 articles</div>
          </div>
        </div>
      </div>
      <aside className="hc-side">
        <div className="pop">
          <div>
            <span className="h">Workspaces</span>
          </div>
          {["Pages and folders", "Sharing", "Export to PDF", "Large exports", "Move a workspace"].map((a) => (
            <div key={a}>
              <span>{a}</span>
              <span className="mut">›</span>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

function InboxPanel() {
  const people = [
    ["PS", "#e07a5f", "Priya Shah", "2m", "Export keeps failing on big…"],
    ["TB", "#3d85c6", "Tom Becker", "14m", "Can I get invoices in EUR?"],
    ["AL", "#8e7cc3", "Ana Lima", "1h", "Love the new dark mode!"],
    ["KM", "#6aa84f", "Kenji Mori", "3h", "Do you support SSO?"],
    ["SN", "#c27ba0", "Sara Novak", "5h", "Moving our team over next…"],
    ["DO", "#f1a33c", "Dan Okafor", "1d", "Calendar view for tasks?"],
  ] as const;
  return (
    <div className="ui panel p-inbox" role="img" aria-label="The inbox: a conversation the AI answered first, handed to the team with a reply drafted">
      <div className="list">
        <div className="lhd">
          <span className="h">
            Open <span className="mut">12</span>
          </span>
          <span className="mut">Newest</span>
        </div>
        {people.map(([initials, color, name, when, line], i) => (
          <div key={name} className={i === 0 ? "cv on" : "cv"}>
            <Face who={initials} color={color} />
            <div className="tx">
              <div className="row">
                <span className="h">{name}</span>
                <span className="mut">{when}</span>
              </div>
              <div className={i === 0 ? undefined : "mut"}>{line}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="thread">
        <div className="thd">
          <span className="h">Priya Shah</span>
          <span className="mut">· via widget</span>
          <div className="r">
            <span className="btn-ui">
              <span className="av xs">M</span>Maya
            </span>
            <span className="btn-ui dk">
              <CheckIcon aria-hidden size={12} />
              Close
            </span>
          </div>
        </div>
        <div className="msgs">
          <div className="m">
            Export keeps failing on our big workspace. It just spins.<small>Priya · 9:41</small>
          </div>
          <div className="m ai">
            Large workspaces are sent by email as one PDF. It should land in a few minutes.<small>AI answer · from “Large exports”</small>
          </div>
          <div className="m">
            Nothing arrived. Can someone take a look?<small>Priya · 9:52</small>
          </div>
          <div className="sys">
            <HandIcon aria-hidden size={12} />
            Handed to the team · assigned to Maya
          </div>
          <div className="note">
            <b>Note</b> · Export queue stalled overnight. Restarted.
          </div>
        </div>
        <Draft>Hi Priya, sorry about that. Your export got stuck on our side. I’ve restarted it, and the PDF is on its way.</Draft>
      </div>
      <aside className="det">
        <div className="cap">Customer</div>
        <div className="kv">
          <span>Name</span>
          <span>Priya Shah</span>
          <span>Company</span>
          <span>Northfield</span>
          <span>Via</span>
          <span>Widget</span>
        </div>
        <div className="cap">Summary</div>
        <div className="mini">Big export stuck. AI pointed to email delivery; nothing arrived.</div>
      </aside>
    </div>
  );
}

function Draft({ children }: { children: ReactNode }) {
  return (
    <div className="comp">
      <div className="top">
        <SparklesIcon aria-hidden size={13} />
        Drafted for you
      </div>
      <p>{children}</p>
      <div className="act">
        <span className="btn-ui">Edit</span>
        <span className="send">Send</span>
      </div>
    </div>
  );
}

const POSTS = [
  [128, "Dark mode", "done", "Completed", "Easier on the eyes for late nights.", 34],
  [96, "Export to PDF with comments", "prog", "In progress", "Reviews happen in comments.", 21],
  [64, "Faster PDF exports", "plan", "Planned", "Big workspaces take a while.", 12],
  [41, "Calendar view for tasks", "rev", "Under review", "See due dates at a glance.", 9],
  [27, "Offline mode on mobile", "plan", "Planned", "For flights and trains.", 6],
] as const;

function FeedbackPanel() {
  const roadmap = [
    ["plan", "Planned", [["Faster PDF exports", 64], ["Offline mode", 27]]],
    ["prog", "In progress", [["PDF with comments", 96]]],
    ["done", "Completed", [["Dark mode", 128], ["Bulk move pages", 52]]],
  ] as const;
  return (
    <div className="ui panel p-fb" role="img" aria-label="A feedback board with votes and statuses, beside its public roadmap">
      <div className="fbm">
        <div className="fbh">
          <div className="brand">
            <i />
            Lumen Feedback
          </div>
          <div className="r">
            <span className="btn-ui">Top</span>
            <span className="btn-ui dk">Post feedback</span>
          </div>
        </div>
        <div className="seg">
          <span className="on">Feature requests</span>
          <span>Bugs</span>
          <span>Integrations</span>
        </div>
        {POSTS.map(([votes, title, kind, status, line, comments], i) => (
          <div className="post" key={title}>
            <div className={i === 0 ? "vote on" : "vote"}>
              <ChevronUpIcon aria-hidden size={14} />
              {votes}
            </div>
            <div className="tx">
              <div className="h">{title}</div>
              <div>
                <Tag kind={kind}>{status}</Tag>
                <span className="mut d">{line}</span>
                <span className="mut">· {comments} comments</span>
              </div>
            </div>
          </div>
        ))}
      </div>
      <aside className="rm">
        <div className="h">Roadmap</div>
        {roadmap.map(([kind, status, cards]) => (
          <div className="rcol" key={status}>
            <div className="hd">
              <Tag kind={kind}>{status}</Tag>
            </div>
            {cards.map(([title, votes]) => (
              <div className="rcard" key={title}>
                <span>{title}</span>
                <span>▲ {votes}</span>
              </div>
            ))}
          </div>
        ))}
      </aside>
    </div>
  );
}

function ChangelogPanel() {
  return (
    <div className="ui panel p-cl" role="img" aria-label="A changelog entry, Dark mode is here, and the next release's draft">
      <div className="clm">
        <div className="clmeta">
          <span className="mut">November 6</span>
          <Tag kind="done">New</Tag>
          <Tag kind="plan">Improved</Tag>
        </div>
        <h4>Dark mode is here</h4>
        <div className="shot">
          <div className="s1">
            {[70, 100, 55, 80, 60].map((w, i) => (
              <i key={i} style={{ width: `${w}%` }} />
            ))}
          </div>
          <div className="s2">
            <b />
            <div className="crd">
              <i style={{ width: "60%" }} />
              <i style={{ width: "85%", margin: 0 }} />
            </div>
            <div className="crd">
              <i style={{ width: "45%" }} />
              <i style={{ width: "70%", margin: 0 }} />
            </div>
          </div>
          <div className="tg">
            <span>Light</span>
            <span className="on">Dark</span>
            <span>System</span>
          </div>
        </div>
        <ul>
          <li>
            Pick Light, Dark or System in <b>Settings → Appearance</b>.
          </li>
          <li>PDF exports are twice as fast.</li>
        </ul>
        <div className="reac">
          <span>♥ 48</span>
          <span>↑ 31</span>
        </div>
        <div className="prev">
          <span className="mut">October 28</span>
          <span className="h">Bulk move pages</span>
          <Tag kind="done">New</Tag>
        </div>
      </div>
      <aside className="cls">
        <div className="cap">Next release · draft</div>
        <div className="draft">
          {["Calendar view for tasks", "Offline mode on mobile", "Faster search"].map((line) => (
            <div className="ln" key={line}>
              <GitMergeIcon aria-hidden size={13} />
              {line}
            </div>
          ))}
          <span className="aib">
            <SparklesIcon aria-hidden size={12} />
            Draft with AI
          </span>
        </div>
      </aside>
    </div>
  );
}

function Merged() {
  return (
    <span className="merged">
      <GitMergeIcon aria-hidden size={13} />
      Merged
    </span>
  );
}

function AutopilotPanel() {
  return (
    <div className="ui panel p-ap" role="img" aria-label="A merged pull request, Add dark mode, and what Autopilot did with it">
      <div className="pr">
        <div className="ph">
          <GithubMark className="size-4 text-foreground" />
          lumen / <b>app</b>
        </div>
        <div className="pb">
          <h5>
            Add dark mode <span>#482</span>
          </h5>
          <div className="row">
            <Merged />
            <span className="mut">sam merged into main</span>
          </div>
          <div className="files">
            {[
              ["settings/appearance.tsx", 84, 12],
              ["theme/tokens.ts", 41, 3],
              ["app/layout.tsx", 6, 2],
            ].map(([file, add, del]) => (
              <div key={file}>
                <span>{file}</span>
                <span>
                  <span className="add">+{add}</span> <span className="del">−{del}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="arr">
        <ArrowRightIcon aria-hidden size={16} />
      </div>
      <div className="feed">
        <div className="fh">
          <TutiMark className="size-5" />
          <span className="h">Autopilot</span>
          <span className="live">Working</span>
        </div>
        <Event icon={<BookOpenIcon {...icon} />} title="Help article updated">
          <Diff />
        </Event>
        <Event icon={<LightbulbIcon {...icon} />} title="Feature request completed">
          <div className="row">
            <Tag kind="plan">Planned</Tag>→<Tag kind="done">Completed</Tag>
          </div>
          <Faces>128 people told</Faces>
        </Event>
        <Event icon={<MegaphoneIcon {...icon} />} title="Changelog drafted">
          <div className="mut">“Dark mode is here”</div>
        </Event>
        <div className="ev muted">
          <div className="ei">
            <GitMergeIcon {...icon} />
          </div>
          <div>
            <div className="h">#481 Upgrade test runner</div>
            <div className="mut">Nothing customers see</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Event({ icon: ic, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="ev">
      <div className="ei">{ic}</div>
      <div>
        <div className="h">{title}</div>
        {children}
      </div>
      <CheckIcon aria-hidden size={16} className="ok" />
    </div>
  );
}

function Eyebrow({ icon: ic, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="eyebrow">
      {ic}
      {children}
    </div>
  );
}

function Ticks({ items }: { items: [ReactNode, string][] }) {
  return (
    <ul className="ticks">
      {items.map(([ic, text]) => (
        <li key={text}>
          <span>{ic}</span>
          {text}
        </li>
      ))}
    </ul>
  );
}

function HelpCenter() {
  return (
    <section id="help">
      <div className="wrap split">
        <div>
          <Eyebrow icon={<BookOpenIcon {...icon} />}>Help center</Eyebrow>
          <h2>Answers customers trust.</h2>
          <p className="sub">Search and AI answers in one box, every answer cited.</p>
          <Ticks
            items={[
              [<GlobeIcon key="g" aria-hidden size={15} />, "Your domain"],
              [<PaletteIcon key="p" aria-hidden size={15} />, "Your brand"],
              [<ChartColumnIcon key="c" aria-hidden size={15} />, "See what customers can’t find"],
            ]}
          />
        </div>
        <div className="canvas hcv" role="img" aria-label="Searching a help center: an AI answer citing two articles, and the matching articles">
          <div className="card cmdk ui">
            <div className="in">
              <SearchIcon aria-hidden size={18} />
              how do I cancel my plan<span className="caret" />
            </div>
            <div className="ai">
              <div className="lbl">
                <SparklesIcon aria-hidden size={14} />
                AI answer
              </div>
              <p>
                Go to <b>Settings → Billing</b> and choose <b>Cancel plan</b>
                <Cite n={1} />. Your workspace stays readable, and you can export everything first
                <Cite n={2} />.
              </p>
            </div>
            <div className="res">
              <div className="cap">Articles</div>
              {[
                ["Change or cancel your plan", "Billing"],
                ["Export your workspace", "Workspaces"],
                ["Download invoices", "Billing"],
              ].map(([title, group], i) => (
                <div key={title} className={i === 0 ? "r on" : "r"}>
                  <FileTextIcon aria-hidden size={16} />
                  {title}
                  <small>{group}</small>
                </div>
              ))}
            </div>
          </div>
          <div className="float tl">
            <GlobeIcon aria-hidden size={16} />
            help.lumen.app
          </div>
          <div className="float br">
            <CheckIcon aria-hidden size={16} />
            Answered from 2 articles
          </div>
        </div>
      </div>
    </section>
  );
}

function Inbox() {
  return (
    <section id="inbox" className="flush">
      <div className="wrap split rev">
        <div className="txt">
          <Eyebrow icon={<InboxIcon {...icon} />}>Inbox</Eyebrow>
          <h2>Every conversation, one inbox.</h2>
          <p className="sub">AI answers first. Your team takes the rest, reply already drafted.</p>
          <Ticks
            items={[
              [<SparklesIcon key="s" aria-hidden size={15} />, "AI-drafted replies"],
              [<UserIcon key="u" aria-hidden size={15} />, "Assign and add notes"],
              [<MailIcon key="m" aria-hidden size={15} />, "Widget and email together"],
            ]}
          />
        </div>
        <div className="canvas cool" role="img" aria-label="A customer chats in the widget, the AI answers, then the team picks it up with a reply drafted">
          <div className="hand ui">
            <div className="card wdg">
              <div className="wh">
                <b>Hi Tom</b>
                <span>How can we help?</span>
              </div>
              <div className="wb">
                <div className="bub u">Can I get invoices in EUR?</div>
                <div className="bub a">
                  <small>
                    <SparklesIcon aria-hidden size={12} />
                    AI answer
                  </small>
                  Yes. Pick EUR under Billing → Currency. It applies from your next invoice.
                </div>
                <div className="bub u">Can you redo last month’s?</div>
                <div className="talk">
                  <MessageCircleIcon aria-hidden size={14} />
                  Talk to the team
                </div>
              </div>
            </div>
            <div className="card ibx">
              <div className="ih">
                <Face who="TB" color="#3d85c6" />
                <div>
                  <div className="h">Tom Becker</div>
                  <div className="mut">Handed over by AI</div>
                </div>
                <div className="r">
                  <span className="btn-ui">
                    <span className="av xs">M</span>Maya
                  </span>
                </div>
              </div>
              <div className="ib">
                <div className="note">
                  <b>Summary</b> · Switched to EUR. Wants October’s invoice reissued.
                </div>
                <Draft>Hi Tom, done. October’s invoice is reissued in EUR and attached here.</Draft>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Feedback() {
  return (
    <section id="feedback" className="flush">
      <div className="wrap">
        <div className="center">
          <Eyebrow icon={<LightbulbIcon {...icon} />}>Feedback, roadmap, changelog</Eyebrow>
          <h2>Hear it. Plan it. Ship it.</h2>
          <p className="sub">Everyone who asked hears when it ships.</p>
        </div>
        <div className="loop">
          <Step n="01" title="Customers post and vote" line="See what matters most." label="A feature request with 128 votes and a comment">
            <div className="pcard ui">
              <div className="row top">
                <div className="vote on">
                  <ChevronUpIcon aria-hidden size={14} />
                  128
                </div>
                <div>
                  <div className="h big">Dark mode</div>
                  <div className="mut">Easier on the eyes for late nights.</div>
                </div>
              </div>
              <Faces>+124 voted</Faces>
              <div className="m wide">
                <b>Ana</b> · Please! My eyes at 2am.
              </div>
            </div>
          </Step>
          <Step n="02" title="Show what’s next" line="A public roadmap, always in sync." label="A roadmap: Planned, In progress and Completed">
            <div className="road ui">
              {(
                [
                  ["plan", "Planned", [["Offline mode", 27], ["Faster exports", 64]]],
                  ["prog", "Building", [["Dark mode", 128], ["PDF comments", 96]]],
                  ["done", "Done", [["Bulk move", 52]]],
                ] as const
              ).map(([kind, status, cards]) => (
                <div className="c" key={status}>
                  <div className="cap">
                    <Tag kind={kind}>{status}</Tag>
                  </div>
                  {cards.map(([title, votes]) => (
                    <div key={title} className={title === "Dark mode" ? "k hl" : "k"}>
                      {title}
                      <small>▲ {votes}</small>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </Step>
          <Step n="03" title="Ship and tell everyone" line="Changelog drafted. Voters told." label="The message voters get: Dark mode is here">
            <div className="card mail ui">
              <div className="mh">
                <Face who="L" color="#6d5efc" />
                <div>
                  <div className="h">Lumen</div>
                  <div className="mut">to ana@…</div>
                </div>
                <Tag kind="done">Completed</Tag>
              </div>
              <div className="mb">
                <div className="h title">You asked. Dark mode is here.</div>
                <div className="mut">Pick Light, Dark or System in Settings → Appearance.</div>
                <span className="send">See what’s new</span>
              </div>
            </div>
          </Step>
        </div>
      </div>
    </section>
  );
}

function Step({ n, title, line, label, children }: { n: string; title: string; line: string; label: string; children: ReactNode }) {
  return (
    <div className="step">
      <div className="pic" role="img" aria-label={label}>
        <span className="num">{n}</span>
        {children}
      </div>
      <div className="tx">
        <h3>{title}</h3>
        <p>{line}</p>
      </div>
    </div>
  );
}

function Widget() {
  return (
    <section id="widget" className="flush">
      <div className="wrap split">
        <div>
          <Eyebrow icon={<MessageCircleIcon {...icon} />}>Widget</Eyebrow>
          <h2>All of it, inside your product.</h2>
          <p className="sub">Help, messages, feedback and what’s new. One script tag.</p>
          <div className="code">
            <span className="k">&lt;script</span> <span className="a">src</span>=<span className="s">&quot;https://tuti.so/widget.js&quot;</span>{" "}
            <span className="a">data-project</span>=<span className="s">&quot;lumen&quot;</span> <span className="a">async</span>
            <span className="k">&gt;&lt;/script&gt;</span>
          </div>
        </div>
        <div className="appw ui" role="img" aria-label="The widget open inside an app: search, a recent message and what's new">
          <div className="fake">
            <div className="l">
              {[60, 100, 75, 50, 80].map((w, i) => (
                <i key={i} style={{ width: `${w}%` }} />
              ))}
            </div>
            <div className="m2">
              <b />
              <div className="bx" />
              <div className="bx" />
              <div className="bx short" />
            </div>
          </div>
          <div className="veil" />
          <div className="wpanel">
            <div className="hd">
              <TutiMark className="size-6.5" />
              <b>
                Hi Ana.
                <br />
                How can we help?
              </b>
            </div>
            <div className="bd">
              <div className="bx srch">
                <SearchIcon aria-hidden size={16} />
                Search or ask AI
              </div>
              <div className="bx">
                <div className="cap">Recent message</div>
                <div className="row">
                  <span className="av sm">M</span>
                  <div className="min">
                    <div className="h">Maya</div>
                    <div className="mut ell">Your export is ready to download.</div>
                  </div>
                </div>
              </div>
              <div className="bx nw">
                <i />
                <div>
                  <div className="cap g">What’s new</div>
                  <div className="h">Dark mode is here</div>
                </div>
              </div>
            </div>
            <div className="wtabs">
              {(
                [
                  [HomeIcon, "Home"],
                  [MessageCircleIcon, "Messages"],
                  [BookOpenIcon, "Help"],
                  [LightbulbIcon, "Feedback"],
                  [MegaphoneIcon, "News"],
                ] as const
              ).map(([Icon, label], i) => (
                <span key={label} className={i === 0 ? "on" : undefined}>
                  <Icon aria-hidden size={17} />
                  {label}
                </span>
              ))}
            </div>
          </div>
          <div className="launch">
            <PlusIcon aria-hidden size={22} strokeWidth={2.4} />
          </div>
        </div>
      </div>
    </section>
  );
}

function Autopilot() {
  return (
    <section id="autopilot" className="ap-band">
      <div className="wrap">
        <div className="center">
          <Eyebrow icon={<ZapIcon {...icon} />}>Autopilot</Eyebrow>
          <h2>You ship code. Tuti does the rest.</h2>
          <p className="sub">Connect GitHub. Every release updates what customers see.</p>
        </div>
        <div className="flow" role="img" aria-label="One merged pull request updates a help article, completes a feature request and drafts the changelog">
          <div className="prbar">
            <GithubMark className="size-5" />
            <b>Add dark mode</b>
            <span className="mut">#482</span>
            <Merged />
          </div>
          <svg className="wires" viewBox="0 0 880 70" preserveAspectRatio="none" aria-hidden>
            <path d="M440 0 C440 40 147 30 147 70" />
            <path d="M440 0 L440 70" />
            <path d="M440 0 C440 40 733 30 733 70" />
          </svg>
          <div className="outs">
            <Out icon={<BookOpenIcon {...icon} />} title="Help center updated">
              <div className="mut">Change your theme</div>
              <Diff />
            </Out>
            <Out icon={<LightbulbIcon {...icon} />} title="Feature request closed">
              <div className="row">
                <Tag kind="plan">Planned</Tag>→<Tag kind="done">Completed</Tag>
              </div>
              <Faces>128 people told</Faces>
            </Out>
            <Out icon={<MegaphoneIcon {...icon} />} title="Changelog drafted">
              <div className="h">Dark mode is here</div>
              <div className="mut">Pick Light, Dark or System in Settings → Appearance.</div>
            </Out>
          </div>
        </div>
      </div>
    </section>
  );
}

function Out({ icon: ic, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="out ui">
      <div className="oh">
        <div className="ei">{ic}</div>
        <h3>{title}</h3>
        <span className="ok">
          <CheckIcon aria-hidden size={12} strokeWidth={3} />
        </span>
      </div>
      {children}
    </div>
  );
}

const SOURCES = [
  ["Intercom", "#1f8ded"],
  ["Featurebase", "#111"],
  ["Ferndesk", "#2f6f3e"],
  ["Canny", "#525df9"],
  ["Frill", "#ff5a5f"],
  ["Nolt", "#f59e0b"],
] as const;

function Switch() {
  return (
    <section id="switch" className="switch">
      <div className="wrap split">
        <div>
          <div className="eyebrow">Switch</div>
          <h2>Bring everything with you.</h2>
          <p className="sub">Articles, feature requests, votes and contacts come across. Old links keep working.</p>
        </div>
        <ul className="srcs2">
          {SOURCES.map(([name, color]) => (
            <li key={name}>
              <i style={{ background: color }}>{name[0]}</i>
              {name}
            </li>
          ))}
          <li className="url2">
            <GlobeIcon aria-hidden size={16} />
            Any help center, by URL
          </li>
        </ul>
      </div>
    </section>
  );
}

function Pricing({ start }: { start: string }) {
  // AI answers and Autopilot are listed where every plan runs them: no AI credits to buy, or Free starts with some.
  const ai = !creditsEnabled() || freeCredits() > 0;
  const included = ["Help center", ...(ai ? ["AI answers"] : []), "Inbox", "Widget", "Feedback board", "Roadmap", "Changelog", ...(ai ? ["Autopilot"] : [])];
  return (
    <section id="pricing">
      <div className="wrap">
        <div className="price">
          <div className="l">
            <div className="eyebrow">Pricing</div>
            <h2>
              Free to start.
              <br />
              Never per seat.
            </h2>
            <p className="sub">One price per project, not per seat.</p>
            <div className="ctas left">
              <Start start={start} arrow={false} />
              <Link className="btn btn-s" href="/pricing">
                See pricing
              </Link>
            </div>
          </div>
          <div className="r">
            <div className="big">
              $0<small>to start</small>
            </div>
            <div className="cap in-every">In every plan</div>
            <ul className="inc">
              {included.map((item) => (
                <li key={item}>
                  <CheckIcon aria-hidden size={16} />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function Faq() {
  const questions: [string, string][] = [
    [
      "How does Autopilot work?",
      "Connect GitHub and pick your repositories. When a pull request merges, Tuti updates the help articles it changes, closes the feature requests it ships and adds it to your changelog draft.",
    ],
    ["Where do AI answers come from?", "From your help center. Every answer links the articles it used."],
    ["Can I move from another tool?", "Yes. Import from Intercom, Featurebase, Ferndesk, Canny, Frill, Nolt or any help center by URL. Your old links redirect."],
    ["Can the help center use my domain?", "Yes, with your logo, colours and fonts."],
    ...(plansEnabled() ? [["Is it really free?", "Yes. A free plan, not a trial. Upgrade when you need more."] as [string, string]] : []),
  ];
  return (
    <section className="flush">
      <div className="wrap faq">
        <h2>Questions, answered.</h2>
        <div>
          {questions.map(([q, a], i) => (
            <details key={q} open={i === 0}>
              <summary>
                {q}
                <PlusIcon aria-hidden size={20} />
              </summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function Final({ start, docs }: Links) {
  return (
    <section className="final">
      <div className="wrap">
        <TutiMark className="mark" />
        <h2>
          Give every customer
          <br />
          an answer.
        </h2>
        <Ctas start={start} docs={docs} />
      </div>
    </section>
  );
}
