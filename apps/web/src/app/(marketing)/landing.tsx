import { articleLimit, creditsEnabled, freeCredits, planCredits, plansEnabled } from "@tuti/shared";
import {
  AlignLeftIcon,
  ArrowRightIcon,
  BookOpenIcon,
  ChartColumnIcon,
  CheckIcon,
  ClockIcon,
  FilePlusIcon,
  GitMergeIcon,
  GlobeIcon,
  HandIcon,
  InboxIcon,
  LightbulbIcon,
  LockIcon,
  MegaphoneIcon,
  MessageCircleIcon,
  SearchIcon,
  SparklesIcon,
  Undo2Icon,
  UsersIcon,
  ZapIcon,
} from "lucide-react";
import localFont from "next/font/local";
import Link from "next/link";
import type { ReactNode } from "react";

import { GithubMark } from "@/components/github-mark";
import { TutiMark } from "@/components/tuti-logo";
import { PLAN_PRICES } from "@/lib/plans";

import "./landing.css";

/**
 * The home page's sections (page.tsx; look in landing.css): one sentence, one big product picture, then what Autopilot
 * does with one merge, how the team stays in charge, the help center, feature requests, switching, pricing and
 * questions. The mock UIs tell one example (Acme's #482 Add scheduled exports) and only show what's shipped.
 */

// The mock UIs are set in Inter, so they read as the product (its portal's font).
const inter = localFont({ src: "../../fonts/inter.woff2", weight: "100 900", variable: "--font-lp-inter" });

/** Where the page's links go: `start` the app when signed in, else sign-up; `docs` Tuti's own help center. */
type Links = { start: string; docs: string };

const startLabel = (start: string) => (start === "/app" ? "Open app" : "Start free");

function Tick({ size = 15 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" className="tick flex-none">
      <circle cx="8" cy="8" r="8" fill="currentColor" />
      <path d="M4.6 8.2l2.2 2.2 4.6-4.8" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Start({ start, className = "btn btn-primary", arrow = true }: { start: string; className?: string; arrow?: boolean }) {
  return (
    <Link href={start} className={className}>
      {startLabel(start)}
      {arrow && <ArrowRightIcon aria-hidden size={16} />}
    </Link>
  );
}

export function Landing({ start, docs, dogfood }: Links & { dogfood: boolean }) {
  return (
    <div data-full className={`lp ${inter.variable}`}>
      <Hero start={start} docs={docs} />
      <Breaks />
      <Autopilot start={start} docs={docs} />
      <Control />
      <HelpCenter docs={docs} dogfood={dogfood} />
      <FeatureRequests />
      <Switch start={start} />
      {plansEnabled() && <Pricing start={start} />}
      <Faq />
      <Final start={start} docs={docs} />
    </div>
  );
}

function Hero({ start, docs }: Links) {
  return (
    <section className="hero">
      <div className="wrap">
        <div className="hero-grid">
          <div>
            {plansEnabled() && (
              <span className="pill">
                <b>Free plan</b> Autopilot included, no credit card
              </span>
            )}
            <h1 className="display">
              You ship.
              <br />
              Your help center
              <br />
              <span className="soft">keeps up.</span>
            </h1>
          </div>
          <div className="hero-side">
            <p>The help center, feature requests and changelog that update themselves when you ship.</p>
            <div className="hero-cta">
              <Start start={start} />
              <a className="btn btn-ghost" href={docs}>
                See a live help center
              </a>
            </div>
            <div className="ticks">
              <span>
                <Tick />
                You review first. Undo anything.
              </span>
            </div>
          </div>
        </div>
        <div className="stage">
          <HeroApp />
        </div>
      </div>
    </section>
  );
}

/** The hero's picture: Autopilot's review of an article it edited, beside what one merged pull request did. */
function HeroApp() {
  return (
    <div className="app" role="img" aria-label="Autopilot's review of #482 Add scheduled exports: an article fixed, a new article, a feature request to close, a changelog line">
      <div className="app-bar">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
        <span className="url">
          <LockIcon aria-hidden size={11} />
          app.tuti.so/acme/autopilot
        </span>
      </div>
      <div className="app-body">
        <aside className="side">
          <div className="ws">
            <span className="sq">A</span>
          </div>
          {[InboxIcon, BookOpenIcon, LightbulbIcon, AlignLeftIcon, MegaphoneIcon].map((Icon, i) => (
            <div key={i} className="it">
              <Icon aria-hidden size={18} />
            </div>
          ))}
          <div className="it on">
            <ZapIcon aria-hidden size={18} />
            <span className="n">1</span>
          </div>
          <div className="it">
            <ChartColumnIcon aria-hidden size={18} />
          </div>
        </aside>
        <div className="main">
          <div className="crumb">
            Help center <span>›</span> Data &amp; exports <span>›</span> <b>Exporting your data</b>
            <span className="tag t-upd" style={{ marginLeft: 6 }}>
              Edited by Autopilot
            </span>
          </div>
          <div className="art-h">Exporting your data</div>
          <div className="from">
            <span className="pr">
              <GithubMark className="size-[15px]" />
              From #482 Add scheduled exports
            </span>
            <span className="text-input">·</span>
            <span className="live">
              <span className="pulse" />
              Goes live in 22h unless you stop it
            </span>
          </div>
          <div className="doc">
            <h4>Run an export</h4>
            <ol>
              <li>
                Open <b>Settings → Data</b> and pick what to export.
              </li>
              <li>
                <del className="del">Click Export now. Exports run by hand.</del>
                <br />
                <ins className="ins">
                  Click <b>Export now</b>, or choose <b>Schedule</b> to send one daily or weekly.
                </ins>
              </li>
              <li>
                <ins className="ins">Scheduled exports arrive by email at 09:00, your time.</ins>
              </li>
            </ol>
            <h4 className="opt">Who can export</h4>
            <p className="opt">
              Owners and admins. <del className="del">Members can&apos;t export.</del> <ins className="ins">Members can export their own boards.</ins>
            </p>
          </div>
          <div className="actions">
            <span className="note">
              <ClockIcon aria-hidden size={14} />
              Saved as a revision tagged #482
            </span>
            <span className="sb">Edit</span>
            <span className="sb">Stop</span>
            <span className="sb p">Publish now</span>
          </div>
        </div>
        <div className="rail">
          <div className="prhead">
            <GitMergeIcon aria-hidden size={18} className="merged" />
            <div>
              <b>#482 Add scheduled exports</b>
              <small>Merged into acme/app · 2h ago</small>
            </div>
          </div>
          <ul className="olist">
            <Outcome title="Article fixed" meta="Exporting your data · 3 lines" tag={<span className="tag t-upd">In 22h</span>} />
            <Outcome title="New article written" meta="Scheduling exports · Data & exports" tag={<span className="tag t-upd">In 22h</span>} />
            <li className="wait">
              <span className="ck">
                <HandIcon aria-hidden size={12} />
              </span>
              <div>
                <b>Feature request to close</b>
                <small>Scheduled exports · tells 41 people</small>
                <span className="mini-btns">
                  <span className="sb p">Approve</span>
                  <span className="sb">Stop</span>
                </span>
              </div>
              <span className="tag t-wait">Needs you</span>
            </li>
            <Outcome title="Changelog line added" meta="“Schedule exports daily or weekly”" tag={<span className="tag t-done">Draft</span>} />
          </ul>
          <div className="nothing">
            <GitMergeIcon aria-hidden size={14} />
            <div>
              <b>#481 Refactor auth middleware</b>
              <small>No visible change</small>
            </div>
            <span className="tag t-skip">Nothing to do</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Outcome({ title, meta, tag }: { title: string; meta: string; tag: ReactNode }) {
  return (
    <li>
      <span className="ck">
        <CheckIcon aria-hidden size={12} strokeWidth={3} />
      </span>
      <div>
        <b>{title}</b>
        <small>{meta}</small>
      </div>
      {tag}
    </li>
  );
}

function Breaks() {
  const rows: [string, string, ReactNode, string, ReactNode][] = [
    ["Help article", "Out of date", "“Exports run by hand. There's no way to repeat them.”", "Corrected", <>“Click Export now, or choose <b>Schedule</b> to send one daily or weekly.”</>],
    [
      "AI answer",
      "Wrong, and sure of it",
      "“Can I schedule exports?” No, exports run by hand.",
      "Right, with a source",
      <>
        “Can I schedule exports?” Yes: Settings → Data → Schedule.{" "}
        <span className="tag t-new" style={{ marginLeft: 4 }}>
          Scheduling exports
        </span>
      </>,
    ],
    [
      "Feature request",
      "Still “Planned”",
      "Scheduled exports, 41 votes. Nobody told.",
      "Completed",
      <span key="done" className="flex items-center gap-2.5">
        Scheduled exports <Faces letters="SMJ" /> 41 people emailed
      </span>,
    ],
  ];
  return (
    <section className="band">
      <div className="wrap breaks">
        <span className="kicker">Sound familiar?</span>
        <h2 className="display">
          Ship on Tuesday. <em>Wrong by Wednesday.</em>
        </h2>
        <div className="rows">
          {rows.map(([label, oldState, before, newState, after]) => (
            <div key={label} className="brow">
              <span className="lab">{label}</span>
              <div className="bcell old">
                <span className="st">{oldState}</span>
                {before}
              </div>
              <span className="barrow" aria-label="becomes">
                <ArrowRightIcon aria-hidden size={18} strokeWidth={2.2} />
              </span>
              <div className="bcell new">
                <span className="st">{newState}</span>
                {after}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Faces({ letters }: { letters: string }) {
  return (
    <span className="av" aria-hidden>
      {[...letters].map((letter, i) => (
        <span key={i} className={`c${i + 1}`}>
          {letter}
        </span>
      ))}
    </span>
  );
}

function Autopilot({ start, docs }: Links) {
  return (
    <section className="s" id="autopilot">
      <div className="wrap">
        <div className="sh">
          <span className="kicker">Autopilot</span>
          <h2 className="display">
            One merge.
            <br />
            The follow-up, handled.
          </h2>
          <p>Connect GitHub once. Autopilot reads each merged change.</p>
        </div>
        <div className="bento">
          <div className="tile t-a">
            <span className="num">01</span>
            <h3>Stale articles, corrected.</h3>
            <p>Line by line, with the reason.</p>
            <div className="mini">
              <div className="hd">
                <BookOpenIcon aria-hidden size={14} />
                Account › Inviting teammates
                <span className="tag t-upd" style={{ marginLeft: "auto" }}>
                  1 change
                </span>
              </div>
              <div style={{ lineHeight: 1.85 }}>
                <del className="del">Invites expire after 7 days.</del>
                <br />
                <ins className="ins">Invites expire after 14 days. Resend one from Members.</ins>
              </div>
              <div className="why">
                <SparklesIcon aria-hidden size={14} />
                <span>
                  <b>Why:</b> #476 sets invite expiry to 14 days.
                </span>
              </div>
            </div>
          </div>
          <div className="tile t-b">
            <span className="num">02</span>
            <h3>New feature, new article.</h3>
            <div className="mini">
              <div className="hd">Account &amp; security</div>
              <div className="coll">
                <div className="r">
                  <BookOpenIcon aria-hidden size={15} />
                  Inviting teammates
                </div>
                <div className="r hl">
                  <FilePlusIcon aria-hidden size={15} />
                  Two-factor sign-in<span className="tag t-new">New</span>
                </div>
                <div className="r">
                  <BookOpenIcon aria-hidden size={15} />
                  Resetting your password
                </div>
              </div>
            </div>
          </div>
          <div className="tile t-c">
            <span className="num">03</span>
            <h3>Feature requests closed, with your OK.</h3>
            <p>Everyone who asked gets an email.</p>
            <div className="mail">
              <div className="mh">
                <span>From Acme</span>
                <span>to 28 people</span>
              </div>
              <div className="mb">
                <div className="subj">Good news: Two-factor sign-in is here</div>
                Thanks for asking for it.
                <br />
                <span className="sb">See the post</span>
              </div>
            </div>
          </div>
          <div className="tile t-d">
            <span className="num">04</span>
            <h3>The changelog draft fills itself.</h3>
            <div className="clog">
              <div className="entry">
                <div className="d">
                  <span className="tag t-upd">Draft</span>November release · 3 changes
                </div>
                <ul>
                  <li className="new">
                    <span className="b" />
                    Two-factor sign-in<span className="pr">#476</span>
                  </li>
                  <li>
                    <span className="b" />
                    Invites now last 14 days<span className="pr">#476</span>
                  </li>
                  <li>
                    <span className="b" />
                    Calendar view<span className="pr">#471</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
          <div className="tile t-e">
            <span className="num">05</span>
            <h3>Already stale? Verify.</h3>
            <p>Checks articles against your code, fixes what&apos;s wrong.</p>
            <div className="mini">
              <div className="hd">
                <SearchIcon aria-hidden size={14} />
                Verify · 3 articles checked
                <span className="tag t-done" style={{ marginLeft: "auto" }}>
                  1 claim fixed
                </span>
              </div>
              <div className="vrow">
                <b>Importing contacts</b>
                <del className="del">CSV files up to 5 MB.</del> <ins className="ins">CSV files up to 25 MB.</ins>
              </div>
              <div className="vrow ok">
                <CheckIcon aria-hidden size={13} strokeWidth={3} />
                Inviting teammates<span>Up to date</span>
              </div>
              <div className="vrow ok">
                <CheckIcon aria-hidden size={13} strokeWidth={3} />
                Two-factor sign-in<span>Up to date</span>
              </div>
            </div>
          </div>
          <div className="tile t-f">
            <span className="num">06</span>
            <h3>Refactors and bumps? Skipped.</h3>
            <p>Logged as “Nothing to do”, with the reason.</p>
            <div className="mini mlog">
              <div className="lr">
                <GitMergeIcon aria-hidden size={14} className="merged" />
                <b>#476 Add two-factor sign-in</b>
                <span className="tag t-upd">3 updates</span>
              </div>
              <div className="lr">
                <GitMergeIcon aria-hidden size={14} />
                <b>#475 Refactor session store</b>
                <span className="tag t-skip">Nothing to do · no visible change</span>
              </div>
              <div className="lr">
                <GitMergeIcon aria-hidden size={14} />
                <b>#474 Bump dependencies</b>
                <span className="tag t-skip">Nothing to do · dependency bump</span>
              </div>
            </div>
          </div>
        </div>
        <div className="mid-cta">
          <Start start={start} />
          <a className="btn btn-ghost" href={docs}>
            See a live help center
          </a>
        </div>
      </div>
    </section>
  );
}

function Control() {
  const rules = [
    { icon: ClockIcon, title: "24-hour review window", text: "Stop it, or publish early." },
    { icon: HandIcon, title: "Waits when unsure", text: "Under 95% confident? It asks you." },
    { icon: UsersIcon, title: "Waits when widely seen", text: "25+ people, or 500+ monthly views." },
    { icon: Undo2Icon, title: "Undo anything", text: "Every edit is a revision tagged with its PR." },
  ];
  return (
    <section className="s control">
      <div className="wrap ctrl-grid">
        <div>
          <span className="kicker">You stay in charge</span>
          <h2 className="display h60">It asks when unsure. And before it&apos;s loud.</h2>
          <div className="rules">
            {rules.map((rule) => (
              <div key={rule.title} className="rule">
                <span className="ri">
                  <rule.icon aria-hidden size={20} />
                </span>
                <div>
                  <b>{rule.title}</b>
                  <span>{rule.text}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="relative">
          <div className="inbox">
            <div className="ih">
              <span className="lg">
                <TutiMark className="size-6" />
              </span>
              <div>
                <b>Tuti Autopilot</b>
                <small>Your daily review · Acme</small>
              </div>
              <span className="mono ml-auto text-xs text-muted-foreground">9:00</span>
            </div>
            <div className="ib">
              <div className="sj">3 updates from yesterday&apos;s merges</div>
              <div className="lead">One needs you. Two go live tonight.</div>
              <div className="qi hot">
                <div className="top">
                  <LightbulbIcon aria-hidden size={16} />
                  Complete “Bulk edit”<span className="tag t-wait">Needs approval</span>
                </div>
                <div className="qwhy">Emails 63 people who asked. Over your 25-person rule.</div>
                <div className="btns">
                  <span className="sb p">Approve</span>
                  <span className="sb">Publish now</span>
                  <span className="sb">Stop</span>
                </div>
              </div>
              <div className="qi">
                <div className="top">
                  <BookOpenIcon aria-hidden size={16} />
                  Editing posts<span className="tag t-upd">Live in 13h</span>
                </div>
                <div className="diffline">
                  <del className="del">Edit posts one at a time.</del> <ins className="ins">Select several posts to edit them together.</ins>
                </div>
                <div className="btns">
                  <span className="sb dark">Publish now</span>
                  <span className="sb">Stop</span>
                </div>
              </div>
              <div className="qi">
                <div className="top">
                  <FilePlusIcon aria-hidden size={16} />
                  New article: Bulk editing posts<span className="tag t-upd">Live in 13h</span>
                </div>
                <div className="btns">
                  <span className="sb dark">Publish now</span>
                  <span className="sb">Stop</span>
                </div>
              </div>
            </div>
            <div className="if">Edit any update on the review page.</div>
          </div>
          <div className="toast">
            <span>Article updated from #478</span>
            <b>Undo</b>
          </div>
        </div>
      </div>
    </section>
  );
}

function HelpCenter({ docs, dogfood }: { docs: string; dogfood: boolean }) {
  return (
    <section className="s hc" id="help-center">
      <div className="wrap">
        <div className="sh center">
          <span className="kicker">The help center</span>
          <h2 className="display">A help center customers actually find answers in.</h2>
          <p>Ask AI cites its sources, or says “I don&apos;t know”.</p>
        </div>
        <div className="hc-shot">
          <div className="flank r widget-m">
            <div className="wh">
              <b>Acme</b>
              <small>How can we help?</small>
            </div>
            <div className="wt">
              <span className="on">Home</span>
              <span>Messages</span>
              <span>Help</span>
              <span>Feedback</span>
              <span>What&apos;s new</span>
            </div>
            <div className="wb">
              <div className="ws2">
                <SearchIcon aria-hidden size={13} />
                Search or ask a question
              </div>
              <div className="wi">
                <b>Two-factor sign-in</b>
                <small>Account &amp; security</small>
              </div>
              <div className="wi">
                <b>Calendar view</b>
                <small>What&apos;s new · 2 days ago</small>
              </div>
            </div>
            <div className="wl">
              <MessageCircleIcon aria-hidden size={18} />
            </div>
          </div>
          <div className="flank l">
            <div className="fh">Failed searches · 30 days</div>
            {(
              [
                ["sso setup", 9],
                ["invoice address", 6],
                ["delete board", 4],
              ] as const
            ).map(([query, count]) => (
              <div key={query} className="fr">
                “{query}”<span>{count}</span>
              </div>
            ))}
          </div>
          <div className="portal">
            <div className="ph">
              <span className="br">
                <span className="sq">A</span>Acme Help
              </span>
              <div className="tabs">
                <span className="on">Help center</span>
                <span>Feature requests</span>
                <span className="x">Roadmap</span>
                <span className="x">Changelog</span>
              </div>
              <span className="mono host">help.acme.com</span>
            </div>
            <div className="pbody">
              <div className="pt">How can we help?</div>
              <div className="ask">
                <div className="q">
                  <SearchIcon aria-hidden size={18} />
                  How do I turn on two-factor sign-in?
                  {/* ⌘ drawn: no font here has it. */}
                  <span className="kbd" aria-label="Command K">
                    <svg aria-hidden width="11" height="11" viewBox="0 0 24 24">
                      <path d="M9 9V6a3 3 0 10-3 3h12a3 3 0 10-3-3v12a3 3 0 103-3H6a3 3 0 103 3V9z" fill="none" stroke="currentColor" strokeWidth="2" />
                    </svg>
                    K
                  </span>
                </div>
                <div className="a">
                  <div className="lbl">
                    <SparklesIcon aria-hidden size={15} />
                    Ask AI
                  </div>
                  Open <b>Settings → Security</b> and choose <b>Two-factor sign-in</b>.<sup>1</sup> Scan the code with your authenticator app, then save your backup codes.
                  <sup>2</sup>
                  <div className="srcs">
                    <span>
                      <b>1</b>Two-factor sign-in
                    </span>
                    <span>
                      <b>2</b>Backup codes
                    </span>
                  </div>
                </div>
                <div className="foot">
                  <span>Not what you needed?</span>
                  <b>Post as feedback</b>
                  <b>Ask a person</b>
                </div>
              </div>
              <div className="cols3">
                {(
                  [
                    [ZapIcon, "Getting started", 6],
                    [BookOpenIcon, "Data & exports", 4],
                    [LockIcon, "Billing & plans", 8],
                  ] as const
                ).map(([Icon, name, count]) => (
                  <div key={name} className="cc">
                    <span className="ic">
                      <Icon aria-hidden size={16} />
                    </span>
                    <b>{name}</b>
                    <span>{count} articles</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="feat">
          <div>Markdown, llms.txt, ChatGPT and Claude</div>
          <div>Failed-search reports</div>
          <div>Your own domain</div>
          <div>Private reader groups</div>
        </div>
        <div className="live-cta">
          <span className="thumb" aria-hidden />
          <div>
            <b>See a live help center.</b>
            <p>{dogfood ? "Tuti's own help center runs on Tuti, kept current by Autopilot." : "Search it. Ask it something."}</p>
          </div>
          <a className="btn btn-ghost" href={docs}>
            See a live help center <ArrowRightIcon aria-hidden size={16} />
          </a>
        </div>
      </div>
    </section>
  );
}

function FeatureRequests() {
  return (
    <section className="loop" id="feature-requests">
      <div className="wrap">
        <div className="sh">
          <span className="kicker">Feature requests, roadmap, changelog</span>
          <h2 className="display">Close the loop with everyone who asked.</h2>
          <p>Board, roadmap and changelog, in step.</p>
        </div>
        <ol className="track">
          <li className="step">
            <div className="n">01</div>
            <h3>Customers ask</h3>
            {(
              [
                ["Calendar view", 52],
                ["Custom fields", 17],
              ] as const
            ).map(([title, votes]) => (
              <div key={title} className="card vote">
                <div className="v">
                  {votes}
                  <small>votes</small>
                </div>
                <div>
                  <div className="tt">{title}</div>
                  <div className="tg">
                    <span className="tag t-plan">Planned</span>
                  </div>
                </div>
              </div>
            ))}
            <div className="card dup">Duplicates merged, votes combined</div>
          </li>
          <li className="step">
            <div className="n">02</div>
            <h3>You show what&apos;s next</h3>
            <div className="card road">
              <div className="col">
                <div className="h">Planned</div>
                <div className="ci">Custom fields</div>
                <div className="ci">Bulk edit</div>
              </div>
              <div className="col">
                <div className="h">In progress</div>
                <div className="ci mv">Calendar view</div>
              </div>
            </div>
          </li>
          <li className="step">
            <div className="n">03</div>
            <h3>You ship it</h3>
            <div className="card">
              <div className="flex items-center gap-2 font-semibold">
                <GitMergeIcon aria-hidden size={15} className="merged" />
                #471 Add calendar view
              </div>
              <div className="meta mt-1">Linked to “Calendar view”</div>
            </div>
            <div className="card">
              <div className="flex items-center gap-2">
                <span className="tag t-done">Completed</span>
                <span className="meta">approved by Priya</span>
              </div>
            </div>
          </li>
          <li className="step fin">
            <div className="n">04</div>
            <h3>They hear it from you</h3>
            <div className="card">
              <div className="flex items-center justify-between">
                <Faces letters="SMJLR" />
                <span className="done-badge">
                  <CheckIcon aria-hidden size={12} strokeWidth={3} />
                  52 emailed
                </span>
              </div>
              <div className="mt-2.5 font-semibold">Good news: Calendar view is here</div>
            </div>
            <div className="card wnew">
              <span className="wdot" />
              <div>
                <b>Calendar view</b>
                <small>What&apos;s new · changelog · RSS</small>
              </div>
            </div>
          </li>
        </ol>
        <div className="foot-note">
          {["Inbox on every plan", "One-script widget", "REST API and MCP"].map((text) => (
            <span key={text}>
              <CheckIcon aria-hidden size={16} />
              {text}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function Switch({ start }: { start: string }) {
  const objections = [
    ["We'll lose our links.", "Old URLs redirect."],
    ["Customers will get spammed.", "Imports are quiet. No emails sent."],
    ["Our articles are already wrong.", "Verify checks them against your code."],
    ["We'll be stuck.", "Export your help center as Markdown."],
  ];
  const sources = ["Featurebase", "Canny", "Frill", "Nolt", "Ferndesk", "Intercom"];
  return (
    <section className="s pb-10!" id="switch">
      <div className="wrap sw-grid">
        <div>
          <span className="kicker">Switch to Tuti</span>
          <h2 className="display h60">Move over without breaking a link.</h2>
          <div className="objs">
            {objections.map(([objection, answer]) => (
              <div key={objection} className="obj">
                <q>{objection}</q>
                <p>{answer}</p>
              </div>
            ))}
          </div>
          <div className="mid-cta mt-8!">
            <Start start={start} />
          </div>
        </div>
        <div className="importer">
          <div className="h">Import into Acme</div>
          <div className="sub">Help center and feature requests. Contacts from Intercom.</div>
          <div className="srcgrid">
            {sources.map((source, i) => (
              <div key={source} className={i === 0 ? "src on" : "src"}>
                <i className={`c${i + 1}`}>{source[0]}</i>
                {source}
              </div>
            ))}
          </div>
          <div className="urlin">
            <GlobeIcon aria-hidden size={16} />
            Or any public help center: <b>help.example.com</b>
          </div>
          <div className="progress">
            {(
              [
                ["Articles and collections", 64],
                ["Feature requests", 212],
                ["Redirects for old URLs", 64],
                ["Emails sent", 0],
              ] as const
            ).map(([what, count]) => (
              <div key={what}>
                <Tick size={16} />
                {what}
                <span>{count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

const number = (value: number) => value.toLocaleString("en");

/** The plans, from the server's settings (as /pricing): their prices, article limits and AI credits. */
function Pricing({ start }: { start: string }) {
  const credits = creditsEnabled();
  const articles = (limit: number | null) => (limit === null ? "Unlimited articles" : `${number(limit)} published articles`);
  const plans = [
    {
      name: "Free",
      price: null,
      lines: [credits && freeCredits() > 0 ? "Autopilot, starter AI credits" : "Autopilot", articles(articleLimit("FREE")), "Feedback, roadmap, changelog, inbox", "3 team members"],
    },
    {
      name: PLAN_PRICES.PRO.name,
      price: PLAN_PRICES.PRO,
      lines: ["Everything in Free", articleLimit("PRO") === null ? "Unlimited articles and team" : `${articles(articleLimit("PRO"))}, unlimited team`, "Your own domain", ...(credits ? [`${number(planCredits("PRO"))} AI credits a month`] : [])],
      dark: true,
    },
    {
      name: PLAN_PRICES.BUSINESS.name,
      price: PLAN_PRICES.BUSINESS,
      lines: ["Everything in Pro", "Private help center", ...(credits ? [`${number(planCredits("BUSINESS"))} AI credits a month`] : [])],
    },
  ];
  return (
    <section className="s pricing" id="pricing">
      <div className="wrap">
        <div className="sh center">
          <span className="kicker">Pricing</span>
          <h2 className="display">Autopilot on every plan.</h2>
          <p>Free too. Per project, never per seat.</p>
        </div>
        <div className="plans">
          {plans.map((plan) => (
            <div key={plan.name} className={plan.dark ? "plan featured" : "plan"}>
              <div className="nm">{plan.name}</div>
              <div className="pr">
                ${plan.price?.month ?? 0}
                {plan.price && <small> /month</small>}
              </div>
              <div className="yr">{plan.price ? `$${plan.price.year}/month billed yearly` : "\u00a0"}</div>
              <ul>
                {plan.lines.map((line, i) => (
                  <li key={line} className={i === 0 ? "hi" : undefined}>
                    <CheckIcon aria-hidden size={16} strokeWidth={2.5} />
                    {line}
                  </li>
                ))}
              </ul>
              <Link href={start} className={plan.dark ? "btn btn-light" : "btn btn-ghost"}>
                {startLabel(start)}
              </Link>
            </div>
          ))}
        </div>
        {credits && (
          <div className="perseat">
            Autopilot uses AI credits: starter on Free, {number(planCredits("PRO"))} on {PLAN_PRICES.PRO.name}, {number(planCredits("BUSINESS"))} on {PLAN_PRICES.BUSINESS.name}.
          </div>
        )}
      </div>
    </section>
  );
}

function Faq() {
  const items = [
    ["Will it publish without me?", "Edits go live after 24 hours unless you stop them. Unsure or widely seen changes wait for you."],
    ["What does Tuti read from GitHub?", "Only repositories you pick. Each merged pull request, once."],
    ["What if it gets something wrong?", "Stop it, edit it, or undo it."],
    ["What if we're not on GitHub?", "Autopilot needs GitHub. Everything else works without it."],
    ["Is this developer documentation?", "No. It's the help center your customers read."],
  ];
  return (
    <section className="s faq-s">
      <div className="wrap faq">
        <div>
          <span className="kicker">Questions</span>
          <h2 className="display h56">Before you connect anything.</h2>
        </div>
        <div>
          {items.map(([question, answer], i) => (
            <details key={question} open={i === 0}>
              <summary>{question}</summary>
              <p>{answer}</p>
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
        <h2 className="display">
          Your next merge
          <br />
          does the follow-up.
        </h2>
        <div className="hero-cta">
          <Start start={start} className="btn btn-light" />
          <a className="btn btn-outline-dark" href={docs}>
            See a live help center
          </a>
        </div>
        {plansEnabled() && (
          <div className="ticks">
            <span>
              <Tick />
              Free plan, no credit card
            </span>
          </div>
        )}
        <div className="peek" aria-hidden>
          <span className="ic">
            <GitMergeIcon size={18} />
          </span>
          <span>
            <span className="tt">Your next merge</span>
            <span className="ss">Articles fixed · feature requests ready to close</span>
          </span>
          <span className="sb p">Review</span>
        </div>
      </div>
    </section>
  );
}
