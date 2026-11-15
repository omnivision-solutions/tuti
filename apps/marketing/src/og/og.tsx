import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import type { ReactNode } from "react";

/*
 * The site's share images (each page's opengraph-image.tsx): one look, the page's own words beside a picture of the
 * product in the home page's style (scenes.tsx). Brand type from fonts/: static cuts of the brand fonts
 * (packages/ui/src/fonts), since the image renderer reads neither woff2 nor variable fonts. Every page's twitter:image
 * follows its og:image.
 */

export const size = { width: 1200, height: 630 };

const GREEN = "#12804a";
const ORANGE = "#f26b1d";
const INK = "#1c1917";
const MUTED = "#57534e";
const LINE = "#e7e2d9";

const font = (file: string) => readFile(join(process.cwd(), "src/og/fonts", file));
const fonts = Promise.all([font("bricolage-grotesque-800.ttf"), font("figtree-500.ttf"), font("figtree-700.ttf")]);

/** The parrot (icon.svg). */
function Mark({ px }: { px: number }) {
  return (
    <svg width={px} height={px} viewBox="0 0 32 32">
      <path d="M16 3C9 3 4 8.5 4 15.5S9 29 15 29c1.5 0 2-1 2-2v-6c4 0 9-2.5 9-9C26 7 21.5 3 16 3Z" fill={GREEN} />
      <path d="M24 10.5c3 .5 5 2.5 5 5.5-2.2-1.2-3.8-1.4-5.6-1.1Z" fill={ORANGE} />
      <circle cx="18.5" cy="10.5" r="2.2" fill="#fff" />
      <circle cx="19" cy="10.5" r="1.1" fill={INK} />
    </svg>
  );
}

const TONES = {
  done: ["#dcf3e5", GREEN],
  prog: ["#fde9dc", "#c2410c"],
  plan: ["#e0ecfb", "#1d4ed8"],
  open: ["#f1eee8", MUTED],
  merged: ["#8250df", "#fff"],
} as const;
type Tone = keyof typeof TONES;

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  const [bg, fg] = TONES[tone];
  return <div style={{ display: "flex", padding: "5px 13px", borderRadius: 999, background: bg, color: fg, fontSize: 19, fontWeight: 700, flexShrink: 0 }}>{children}</div>;
}

function Check() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 34, height: 34, borderRadius: 999, background: GREEN, flexShrink: 0 }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </div>
  );
}

const card = { display: "flex", flexDirection: "column", background: "#fff", border: `2px solid ${LINE}`, borderRadius: 22, boxShadow: "0 18px 40px -16px rgba(28,25,23,0.22)" } as const;

/** A merged pull request and what it changed for customers: the home page's hero (HeroAutopilot). */
export function MergeVisual() {
  const results: [string, string][] = [
    ["Article updated", "Sync with Google Calendar"],
    ["Feature request completed", "42 voters emailed"],
    ["Changelog drafted", "Two-way Google Calendar sync"],
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", width: 480, gap: 18 }}>
      <div style={{ ...card, padding: "22px 26px", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: MUTED, fontSize: 20 }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill={INK}>
            <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.4-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
          </svg>
          lumen / app
          <div style={{ display: "flex", marginLeft: "auto" }}>
            <Pill tone="merged">Merged</Pill>
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 25, fontWeight: 700, color: INK }}>
          Two-way Google Calendar sync<span style={{ color: MUTED, fontWeight: 500, marginLeft: 8 }}>#230</span>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "center", color: GREEN }}>
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke={GREEN} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 4v16M5 13l7 7 7-7" />
        </svg>
      </div>
      <div style={{ ...card, padding: "8px 26px" }}>
        {results.map(([done, what], n) => (
          <div key={done} style={{ display: "flex", alignItems: "center", gap: 16, padding: "15px 0", borderTop: n ? `2px solid ${LINE}` : "none" }}>
            <Check />
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", fontSize: 25, fontWeight: 700, color: INK }}>{done}</div>
              <div style={{ display: "flex", fontSize: 19, color: MUTED }}>{what}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A row in a window: a vote count, its words, a status. */
export type Row = { text: string; votes?: number; pill?: [string, Tone] };

/** A product window (the address bar, a search box or question, rows): a feature's page in a glance. */
export function WindowVisual({ url, query, answer, rows }: { url: string; query?: string; answer?: string; rows: Row[] }) {
  return (
    <div style={{ ...card, width: 480, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "16px 20px", borderBottom: `2px solid ${LINE}`, background: "#faf8f3" }}>
        {["#f87171", "#fbbf24", "#4ade80"].map((c) => (
          <div key={c} style={{ display: "flex", width: 13, height: 13, borderRadius: 99, background: c }} />
        ))}
        <div style={{ display: "flex", marginLeft: 14, padding: "4px 16px", borderRadius: 99, background: "#fff", border: `2px solid ${LINE}`, fontSize: 17, color: MUTED }}>{url}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", padding: "20px 24px", gap: 4 }}>
        {query && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 18px", marginBottom: 10, borderRadius: 14, border: `2px solid ${GREEN}`, fontSize: 22, color: INK }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={MUTED} strokeWidth="2.6" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            {query}
          </div>
        )}
        {answer && (
          <div style={{ display: "flex", padding: "16px 20px", marginBottom: 6, borderRadius: 14, background: "#dcf3e5", fontSize: 22, lineHeight: 1.35, color: INK }}>{answer}</div>
        )}
        {rows.map(({ text, votes, pill }, n) => (
          <div key={text} style={{ display: "flex", alignItems: "center", gap: 16, padding: "13px 0", borderTop: n || query ? `2px solid ${LINE}` : "none" }}>
            {votes !== undefined && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 56, padding: "4px 0", borderRadius: 10, border: `2px solid ${LINE}`, fontSize: 20, fontWeight: 700, color: INK, flexShrink: 0 }}>
                <svg width="16" height="12" viewBox="0 0 16 12" fill={GREEN}>
                  <path d="M8 1 15 11H1Z" />
                </svg>
                {votes}
              </div>
            )}
            <div style={{ display: "flex", flexGrow: 1, fontSize: 23, fontWeight: 700, color: INK }}>{text}</div>
            {pill && <Pill tone={pill[1]}>{pill[0]}</Pill>}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A page's share image: the logo, an eyebrow, the headline and a line on the left, `visual` on the right (without one,
 * the words take the width).
 */
export async function shareImage({ eyebrow, headline, accent, line, visual }: { eyebrow?: string; headline: string; accent?: string; line?: string; visual?: ReactNode }) {
  const [heading, regular, bold] = await fonts;
  const wide = !visual;
  const length = Math.max(headline.length, accent?.length ?? 0);
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", padding: "56px 55px 56px 64px", alignItems: "center", background: "#faf8f3", fontFamily: "Figtree", position: "relative" }}>
        {visual && <div style={{ display: "flex", position: "absolute", top: 0, bottom: 0, right: 0, width: 590, background: "#e4f1e8" }} />}
        <div style={{ display: "flex", position: "absolute", left: 0, right: 0, bottom: 0, height: 10, background: `linear-gradient(90deg, ${GREEN} 0%, ${GREEN} 78%, ${ORANGE} 78%)` }} />
        <div style={{ display: "flex", flexDirection: "column", height: "100%", width: wide ? 1072 : 516, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: "Bricolage Grotesque", fontSize: 40, color: INK }}>
            <Mark px={50} />
            tuti
          </div>
          <div style={{ display: "flex", flexDirection: "column", flex: 1, justifyContent: "center", gap: 22 }}>
            {eyebrow && <div style={{ display: "flex", fontSize: 26, fontWeight: 700, color: GREEN, letterSpacing: 0.5 }}>{eyebrow}</div>}
            <div style={{ display: "flex", flexDirection: "column", fontFamily: "Bricolage Grotesque", fontSize: wide ? 96 : length > 40 ? 58 : length > 20 ? 68 : 76, lineHeight: 1.02, letterSpacing: -1.5, color: INK }}>
              <div style={{ display: "flex" }}>{headline}</div>
              {accent && <div style={{ display: "flex", color: GREEN }}>{accent}</div>}
            </div>
            {line && <div style={{ display: "flex", fontSize: wide ? 34 : 26, lineHeight: 1.3, color: MUTED, maxWidth: 900 }}>{line}</div>}
          </div>
        </div>
        {visual && <div style={{ display: "flex", marginLeft: "auto" }}>{visual}</div>}
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Bricolage Grotesque", data: heading, weight: 800, style: "normal" },
        { name: "Figtree", data: regular, weight: 500, style: "normal" },
        { name: "Figtree", data: bold, weight: 700, style: "normal" },
      ],
    },
  );
}
