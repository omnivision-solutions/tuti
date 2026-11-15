import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

/**
 * The card a shared /app link shows (the /app layout names it: unfurlers aren't signed in, so they see sign-in, or a
 * page open to everyone like /app/license). A route, not an opengraph-image file: in a route group, that one's address
 * gets a hash, which the layout couldn't name. Drawn at build time, the same for everyone: nothing in it is a project's.
 * Its fonts are the brand's (packages/ui/src/fonts) at one weight each, as TTF: ImageResponse can't read woff2.
 */
const size = { width: 1200, height: 630 };

// Drawn once, at build time.
export const dynamic = "force-static";

const GREEN = "#12804a";
const ORANGE = "#f26b1d";
const PAPER = "#fbf9f3";
const INK = "#1c1917";

const font = (name: string) => readFile(join(process.cwd(), "src/app/app/(account-pages)/auth", name));

function Mark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <path d="M16 3C9 3 4 8.5 4 15.5S9 29 15 29c1.5 0 2-1 2-2v-6c4 0 9-2.5 9-9C26 7 21.5 3 16 3Z" fill={GREEN} />
      <path d="M24 10.5c3 .5 5 2.5 5 5.5-2.2-1.2-3.8-1.4-5.6-1.1Z" fill={ORANGE} />
      <circle cx="18.5" cy="10.5" r="2.2" fill="#fff" />
      <circle cx="19" cy="10.5" r="1.1" fill={INK} />
    </svg>
  );
}

const PARTS = ["Docs", "AI answers", "Inbox", "Feedback", "Changelog"];

export async function GET() {
  const [heading, text] = await Promise.all([font("bricolage-grotesque-700.ttf"), font("figtree-500.ttf")]);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: PAPER, fontFamily: "Figtree", color: INK }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "72px 0 72px 80px", width: 760 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, fontFamily: "Bricolage", fontSize: 48, letterSpacing: -1 }}>
            <Mark size={60} />
            tuti
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
            <div style={{ display: "flex", flexDirection: "column", fontFamily: "Bricolage", fontSize: 72, lineHeight: 1.04, letterSpacing: -2.5 }}>
              <span>The help center</span>
              <span>that stays in sync</span>
              <span style={{ color: GREEN }}>with your code.</span>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              {PARTS.map((part) => (
                <div
                  key={part}
                  style={{ display: "flex", padding: "6px 16px", borderRadius: 999, border: "2px solid #e4ddcc", background: "#fff", fontSize: 22, color: "#57534e" }}
                >
                  {part}
                </div>
              ))}
            </div>
          </div>
        </div>
        {/* The parrot, big, on a green panel with an orange sun behind it. */}
        <div style={{ display: "flex", flex: 1, margin: 28, borderRadius: 40, background: GREEN, alignItems: "center", justifyContent: "center", position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", width: 360, height: 360, borderRadius: 999, background: ORANGE, top: -110, right: -110, opacity: 0.95 }} />
          <div style={{ position: "absolute", width: 260, height: 260, borderRadius: 999, background: "#0e6b3d", bottom: -80, left: -60 }} />
          <div style={{ display: "flex", width: 280, height: 280, borderRadius: 999, background: PAPER, alignItems: "center", justifyContent: "center" }}>
            <Mark size={210} />
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Bricolage", data: heading, weight: 700, style: "normal" },
        { name: "Figtree", data: text, weight: 500, style: "normal" },
      ],
    },
  );
}
