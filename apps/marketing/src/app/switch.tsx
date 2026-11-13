"use client";

import {
  ArrowRightIcon,
  BookOpenIcon,
  CircleUserRoundIcon,
  GlobeIcon,
  InboxIcon,
  LightbulbIcon,
  LinkIcon,
  MegaphoneIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import Image, { type StaticImageData } from "next/image";
import { type ReactNode, useState } from "react";

import { TutiMark } from "@tuti/ui/tuti-logo";

import canny from "./logos/canny.svg";
import featurebase from "./logos/featurebase.svg";
import ferndesk from "./logos/ferndesk.svg";
import frill from "./logos/frill.svg";
import intercom from "./logos/intercom.svg";
import nolt from "./logos/nolt.svg";

const i = { "aria-hidden": true, size: 20 } as const;

// What each import brings, in apps/web's words (apps/web/src/lib/import-parts.ts, IMPORT_PARTS' `brings`). Keep in step.
const PARTS = {
  team: ["Team", "Your team, as invitations to send", <UserPlusIcon key="i" {...i} />],
  contacts: ["Contacts", "Your users, with their custom fields", <UsersIcon key="i" {...i} />],
  feedback: ["Feedback", "Boards, posts, votes and comments", <LightbulbIcon key="i" {...i} />],
  changelog: ["Changelog", "Your updates, with their images", <MegaphoneIcon key="i" {...i} />],
  docs: ["Help center", "Collections and articles, with their images", <BookOpenIcon key="i" {...i} />],
  inbox: ["Inbox", "Conversations and their messages", <InboxIcon key="i" {...i} />],
  avatars: ["Profile pictures", "Your users' profile pictures", <CircleUserRoundIcon key="i" {...i} />],
  // Only an import by address redirects old links by itself (@tuti/jobs import-docs).
  redirects: ["Old links", "Redirect to the new pages", <LinkIcon key="i" {...i} />],
} as const satisfies Record<string, [string, string, ReactNode]>;
type Part = keyof typeof PARTS;

// Each tool's parts (IMPORT_SOURCES' `parts`), with its own words where its `partDescriptions` differ.
const TOOLS: { name: string; logo: StaticImageData | null; parts: Part[]; words?: Partial<Record<Part, string>> }[] = [
  { name: "Featurebase", logo: featurebase, parts: ["team", "contacts", "feedback", "changelog", "docs", "inbox", "avatars"] },
  { name: "Intercom", logo: intercom, parts: ["contacts", "docs", "avatars"] },
  {
    name: "Ferndesk",
    logo: ferndesk,
    parts: ["contacts", "changelog", "docs", "inbox"],
    words: { contacts: "Your help center's users, with their attributes", changelog: "Your changelog entries, with their images", inbox: "Your AI assistant's conversations" },
  },
  { name: "Canny", logo: canny, parts: ["contacts", "feedback", "changelog", "avatars"] },
  {
    name: "Frill",
    logo: frill,
    parts: ["contacts", "feedback", "changelog", "avatars"],
    words: { contacts: "Your users, with their names and email addresses", feedback: "Your ideas, with their votes and comments", changelog: "Your announcements, with their images" },
  },
  { name: "Nolt", logo: nolt, parts: ["contacts", "feedback", "avatars"], words: { contacts: "Your board's users", feedback: "Your board, with its posts, upvotes and comments" } },
  { name: "Any help center", logo: null, parts: ["docs", "redirects"], words: { docs: "Its articles, with their images and links" } },
];

function Logo({ tool, size }: { tool: (typeof TOOLS)[number]; size: number }) {
  return tool.logo ? (
    <Image src={tool.logo} alt="" width={size} height={size} unoptimized className="lg" />
  ) : (
    <span className="lg web" style={{ width: size, height: size }}>
      <GlobeIcon aria-hidden size={size * 0.55} />
    </span>
  );
}

/** Switch: a tile per tool Tuti imports from; the picked one's parts land in Tuti as chips. Logos only say "import from". */
export function Switch() {
  const [picked, setPicked] = useState(0);
  const tool = TOOLS[picked];
  return (
    <section id="switch" className="sw">
      <div className="wrap">
        <div className="center">
          <div className="eyebrow">
            <ArrowRightIcon aria-hidden size={16} />
            Switch
          </div>
          <h2>Bring everything with you.</h2>
          <p className="sub">Pick your old tool. It all comes across.</p>
        </div>
        <div className="tiles">
          {TOOLS.map((t, n) => (
            <button key={t.name} type="button" className="tile" aria-pressed={n === picked} aria-controls="lands" onClick={() => setPicked(n)}>
              <Logo tool={t} size={48} />
              {t.name}
            </button>
          ))}
        </div>
        <div id="lands" className="dock" aria-live="polite">
          <div className="dh">
            <Logo tool={tool} size={32} />
            <ArrowRightIcon aria-hidden size={18} />
            <TutiMark className="size-8" />
            <h3>
              Lands in Tuti<span className="sr-only"> from {tool.name}</span>
            </h3>
          </div>
          <ul key={tool.name} className="land">
            {tool.parts.map((part) => {
              const [label, line, ic] = PARTS[part];
              return (
                <li key={part} className={part === "redirects" ? "chip hl" : "chip"}>
                  <span className="pi">{ic}</span>
                  <b>{label}</b>
                  <small>{tool.words?.[part] ?? line}</small>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
