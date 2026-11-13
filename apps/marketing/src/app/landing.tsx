import {
  ArrowRightIcon,
  BookOpenIcon,
  ChartColumnIcon,
  CheckIcon,
  GitMergeIcon,
  InboxIcon,
  LightbulbIcon,
  MapIcon,
  MegaphoneIcon,
  MessageCircleIcon,
  PlusIcon,
  ShieldCheckIcon,
  ZapIcon,
} from "lucide-react";
import Image, { type StaticImageData } from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

import { GithubMark } from "@tuti/ui/github-mark";
import { TutiMark } from "@tuti/ui/tuti-logo";

import { HeroTabs } from "./hero-tabs";
import { DOCS, REPO_URL, SIGN_UP } from "./links";
import { Switch } from "./switch";
import "./landing.css";
// Screenshots of the app and a portal, with the made-up company "Lumen"'s data, 2× pixels. Next resizes them per screen.
import apSync from "./shots/app-autopilot-sync.webp";
import inbox from "./shots/app-inbox-2.webp";
import reporting from "./shots/app-reporting.webp";
import cropAi from "./shots/crop-ai.webp";
import cropCompleting from "./shots/crop-completing.webp";
import cropSync from "./shots/crop-sync.webp";
import aiAnswer from "./shots/portal-ai-answer.webp";
import board from "./shots/portal-board.webp";
import changelog from "./shots/portal-changelog.webp";
import docs from "./shots/portal-docs.webp";
import roadmap from "./shots/portal-roadmap.webp";
import widgetHome from "./shots/widget-home.webp";
import widgetNews from "./shots/widget-news.webp";

/**
 * The home page (page.tsx; look in landing.css): the promise over a window onto each part of Tuti, Autopilot's steps,
 * a grid of the rest, switching, open source, pricing and questions. Copy is short and unqualified: plan details live on
 * /pricing (docs/design.md, Marketing copy). Pictures are real screenshots of the app.
 */

// Links into the app are plain links (another app on this domain), not client navigation.
function Start({ arrow = true }: { arrow?: boolean }) {
  return (
    <a href={SIGN_UP} className="btn btn-p">
      Start free trial
      {arrow && <ArrowRightIcon aria-hidden size={16} />}
    </a>
  );
}

function Ctas() {
  return (
    <div className="ctas">
      <Start />
      {/* Tuti's own help center, on Tuti. */}
      <a className="btn btn-s" href={DOCS}>
        See a live help center
      </a>
    </div>
  );
}

/** `aiInEveryPlan`: whether every plan runs AI answers and Autopilot (the app's /api/plans); null without the app, then no pricing. */
export function Landing({ aiInEveryPlan }: { aiInEveryPlan: boolean | null }) {
  return (
    <div data-full className="lp">
      <Hero />
      <Autopilot />
      <Bento />
      <Switch />
      <OpenSource />
      {aiInEveryPlan !== null && <Pricing ai={aiInEveryPlan} />}
      <Faq />
      <Final />
    </div>
  );
}

const icon = { "aria-hidden": true, size: 16 } as const;

/** A screenshot as wide as the window it's in, up to `max` CSS pixels. */
const Shot = ({ src, alt, max, className, preload }: { src: StaticImageData; alt: string; max: number; className?: string; preload?: boolean }) => (
  <Image src={src} alt={alt} sizes={`(max-width: ${max}px) 100vw, ${max}px`} className={className} preload={preload} />
);

function Hero() {
  // The window is open on Autopilot first.
  const panels: [string, ReactNode, string, StaticImageData, string][] = [
    ["Autopilot", <ZapIcon key="i" {...icon} />, "tuti.so/app/lumen/autopilot", apSync, "Autopilot's review of a help article rewritten after pull request #230: the old steps struck out, the new ones added"],
    ["Help center", <BookOpenIcon key="i" {...icon} />, "help.lumen.app", aiAnswer, "A help center with an AI answer to “How do I cancel my plan?”, citing the article it came from"],
    ["Inbox", <InboxIcon key="i" {...icon} />, "tuti.so/app/lumen/inbox", inbox, "The inbox: conversations waiting for a reply, one open beside the customer's details"],
    ["Feedback", <LightbulbIcon key="i" {...icon} />, "help.lumen.app/feedback", board, "A feedback board of feature requests, with their statuses and votes"],
    ["Changelog", <MegaphoneIcon key="i" {...icon} />, "help.lumen.app/changelog", changelog, "A public changelog, its entries tagged New, Improved and Fixed"],
  ];
  return (
    <header className="hero">
      <div className="wrap">
        <a className="os-pill" href={REPO_URL}>
          <span className="gi">
            <GithubMark className="size-3.5" />
          </span>
          Open source
          <ArrowRightIcon aria-hidden size={14} className="arr" />
        </a>
        <h1>
          Ship code. <em>Your help center keeps&nbsp;up.</em>
        </h1>
        <p className="lead">Help center, AI answers and feedback board, updated every time you ship.</p>
        <Ctas />
      </div>
      <div className="frame">
        <HeroTabs
          panels={panels.map(([label, ic, url, src, alt], i) => ({
            label,
            icon: ic,
            url,
            picture: <Shot src={src} alt={alt} max={1180} preload={i === 0} />,
          }))}
        />
      </div>
    </header>
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

function Step({ n, title, line, children }: { n: ReactNode; title: string; line: string; children: ReactNode }) {
  return (
    <li className="st">
      <div className={typeof n === "string" ? "n" : "n gh"}>{n}</div>
      <h3>{title}</h3>
      <p>{line}</p>
      <div className="pic">{children}</div>
    </li>
  );
}

function Autopilot() {
  return (
    <section id="autopilot" className="line">
      <div className="wrap">
        <div className="center">
          <Eyebrow icon={<ZapIcon {...icon} />}>Autopilot</Eyebrow>
          <h2>You ship code. Tuti does the rest.</h2>
          <p className="sub">One merge updates everything customers see.</p>
        </div>
        <ol className="steps">
          <Step n={<GithubMark className="size-5" />} title="You merge" line="A pull request lands on main.">
            <div className="prc">
              <div className="r">
                <GithubMark className="size-4" /> lumen / app
              </div>
              <div className="t">
                Two-way Google Calendar sync <span>#230</span>
              </div>
              <span className="merged">
                <GitMergeIcon aria-hidden size={12} /> Merged
              </span>
              <div className="f" aria-hidden>
                <span>
                  sync/google.ts <b>+212</b> <em>−40</em>
                </span>
                <span>
                  settings/integrations.tsx <b>+66</b> <em>−8</em>
                </span>
                <span>
                  jobs/sync-calendars.ts <b>+91</b>
                </span>
              </div>
            </div>
          </Step>
          <Step n="1" title="Help center rewritten" line="The article now says what shipped.">
            <Shot src={cropSync} max={300} alt="The article “Sync with Google Calendar”, its old import steps struck out and the new sync steps added" />
          </Step>
          <Step n="2" title="Feature request completed" line="Every voter gets the news.">
            <Shot src={cropCompleting} max={300} alt="The feature request “Dark mode” moving from Planned to Completed, with an email to the 27 people on it" />
          </Step>
          <Step n="3" title="Changelog drafted" line="Ready to publish, in your words.">
            <Shot src={widgetNews} max={300} alt="The changelog entry “Fewer duplicate reminders” in the in-app widget's What's new" />
          </Step>
        </ol>
      </div>
    </section>
  );
}

function Cell({ id, className, icon: ic, label, title, line, children }: { id?: string; className: string; icon: ReactNode; label: string; title: string; line?: string; children?: ReactNode }) {
  return (
    <div id={id} className={`cell ${className}`}>
      <Eyebrow icon={ic}>{label}</Eyebrow>
      <h3>{title}</h3>
      {line && <p>{line}</p>}
      {children}
    </div>
  );
}

function Bento() {
  return (
    <section className="bento-s">
      <div className="wrap">
        <div className="center">
          <h2>One place for every customer question.</h2>
          <p className="sub">Help center, inbox, feedback and changelog, all connected.</p>
        </div>
        <div className="bento">
          <Cell id="help" className="c-help" icon={<BookOpenIcon {...icon} />} label="Help center" title="Answers customers trust." line="Search and AI answers in one box, every answer cited.">
            <div className="pics">
              <Shot src={docs} max={760} className="bl" alt="A help center's home page: a search box over collections and popular articles" />
              <Shot src={cropAi} max={250} className="over" alt="An AI answer to “How do I cancel my plan?”, with its source linked" />
            </div>
          </Cell>
          <Cell className="c-wdg" icon={<MessageCircleIcon {...icon} />} label="Widget" title="All of it, in your app." line="One script tag.">
            <Shot src={widgetHome} max={270} className="wdg" alt="The in-app widget: help search, popular articles, a message to the team and Share an idea" />
          </Cell>
          <Cell id="inbox" className="c-inbox" icon={<InboxIcon {...icon} />} label="Inbox" title="Every conversation, one inbox." line="AI answers first. Your team takes the rest.">
            <Shot src={inbox} max={900} className="bl" alt="The inbox: conversations waiting for a reply, one open beside the customer's details" />
          </Cell>
          <Cell id="feedback" className="c-fb" icon={<LightbulbIcon {...icon} />} label="Feedback" title="Customers vote." line="See which feature requests matter most.">
            <Shot src={board} max={560} className="bl" alt="A feedback board of feature requests, with their statuses and votes" />
          </Cell>
          <Cell className="c-rm" icon={<MapIcon {...icon} />} label="Roadmap" title="Show what's next.">
            <Shot src={roadmap} max={700} className="bl" alt="A public roadmap with Planned, In progress and Completed columns" />
          </Cell>
          <Cell className="c-cl" icon={<MegaphoneIcon {...icon} />} label="Changelog" title="Tell everyone it shipped.">
            <Shot src={changelog} max={700} className="bl" alt="A public changelog, its entries tagged New, Improved and Fixed" />
          </Cell>
          <div className="cell c-dark">
            <Eyebrow icon={<ShieldCheckIcon {...icon} />}>Verify</Eyebrow>
            <h3 className="big">Checked against your code.</h3>
            <p>Every article, on demand.</p>
          </div>
          <Cell className="c-rep" icon={<ChartColumnIcon {...icon} />} label="Reporting" title="See what customers can't find.">
            <Shot src={reporting} max={900} className="bl" alt="Help center reporting: article views, searches and searches that found nothing, by day" />
          </Cell>
        </div>
      </div>
    </section>
  );
}

// The README's Self-hosting steps, as it writes them: its web image, run with its variables in .env.
const SELF_HOST = [`git clone ${REPO_URL}`, "cd tuti", "docker build -f apps/web/Dockerfile -t tuti-web .", "docker run -p 3000:3000 --env-file .env tuti-web"];

function OpenSource() {
  return (
    <section id="open-source" className="oss">
      <div className="wrap">
        <div className="center">
          <Eyebrow icon={<GithubMark className="size-4" />}>Open source</Eyebrow>
          <h2>Run it yourself, or let us.</h2>
          <p className="sub">The same Tuti, open source, either way.</p>
        </div>
        <div className="two">
          <div className="card self">
            <span className="tag">
              <GithubMark className="size-3.5" /> Self-host
            </span>
            <h3>Your servers. No plan limits.</h3>
            <p>Free, with your data on your own servers.</p>
            <div className="term">
              <div className="tb" aria-hidden>
                <i />
                <i />
                <i />
                <span>your-server ~ tuti</span>
              </div>
              <pre>
                {SELF_HOST.map((step) => (
                  <div key={step}>
                    <span className="p">$</span> {step}
                  </div>
                ))}
              </pre>
            </div>
            <a className="btn btn-d" href={`${REPO_URL}#self-hosting`}>
              <GithubMark className="size-4.5" /> Self-host free
            </a>
          </div>
          <div className="card">
            <span className="tag">
              <TutiMark className="size-4" /> Tuti cloud
            </span>
            <h3>We run it for you.</h3>
            <p>Hosting and updates, handled.</p>
            <ul>
              {["Nothing to install", "Your domain and brand", "Never priced per seat"].map((item) => (
                <li key={item}>
                  <CheckIcon aria-hidden size={18} />
                  {item}
                </li>
              ))}
            </ul>
            <Start />
          </div>
        </div>
      </div>
    </section>
  );
}

function Pricing({ ai }: { ai: boolean }) {
  // AI answers and Autopilot are listed where every plan runs them.
  const included = ["Help center", ...(ai ? ["AI answers"] : []), "Inbox", "Widget", "Feedback board", "Roadmap", "Changelog", ...(ai ? ["Autopilot"] : [])];
  return (
    <section id="pricing" className="pricing">
      <div className="strip">
        <div className="l">
          <div className="eyebrow">Pricing</div>
          <h2>
            Try it free.
            <br />
            Never per seat.
          </h2>
          <p className="sub">One price per project, not per seat.</p>
          <div className="ctas left">
            <Start arrow={false} />
            <Link className="btn btn-d" href="/pricing">
              See pricing
            </Link>
          </div>
        </div>
        <div className="r">
          {/* "Try it free" is the heading: the figure alone stays on one line in the narrow column. */}
          <div className="big">7 days</div>
          <div className="cap">In every plan</div>
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
    </section>
  );
}

function Faq() {
  const questions: [string, string][] = [
    [
      "How does Autopilot work?",
      "Connect GitHub and pick your repositories. When a pull request merges, Tuti updates the help articles it changes, closes the feature requests it ships and adds it to your changelog draft.",
    ],
    ["Is Tuti open source?", "Yes. Self-host it free, with no plan limits, or let us run it for you."],
    ["Where do AI answers come from?", "From your help center. Every answer links the articles it used."],
    ["Can I move from another tool?", "Yes. Import from Intercom, Featurebase, Ferndesk, Canny, Frill, Nolt or any help center by URL. Old links can point to the new pages."],
    ["Can the help center use my domain?", "Yes, with your logo, colours and fonts."],
    ["How does the free trial work?", "Your first project gets 7 days free, no card needed. Pick a plan whenever you're ready."],
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

function Final() {
  return (
    <section className="final">
      <div className="wrap">
        <TutiMark className="mark" />
        <h2>Give every customer an answer.</h2>
        <Ctas />
      </div>
    </section>
  );
}
