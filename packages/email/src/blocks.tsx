import { Text } from "@react-email/components";
import type { ReactNode } from "react";

import { accentColors, colors } from "./layout";

/** A post's status (PostStatus in @tuti/db; this package doesn't depend on it). */
export type PostStatus = "OPEN" | "UNDER_REVIEW" | "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "CLOSED";

/**
 * The portal's status hues (docs/design.md, Layout → Portals: `status-*` in its light mode, Closed the muted text), as
 * hex: the colour, then its pill's fill and edge (StatusPill: the colour at 8% and 25% on white).
 */
export const STATUS_PILLS: Record<PostStatus, { label: string; color: string; fill: string; edge: string }> = {
  OPEN: { label: "Open", color: "#69625d", fill: "#f3f2f2", edge: "#dad8d7" },
  UNDER_REVIEW: { label: "Under review", color: "#7d4dbe", fill: "#f5f1fa", edge: "#dfd3ef" },
  PLANNED: { label: "Planned", color: "#1467c2", fill: "#ecf3fa", edge: "#c4d9f0" },
  IN_PROGRESS: { label: "In progress", color: "#b14600", fill: "#f9f0eb", edge: "#ecd1bf" },
  COMPLETED: { label: "Completed", color: "#137738", fill: "#ecf4ef", edge: "#c4ddcd" },
  CLOSED: { label: "Closed", color: "#625c58", fill: "#f2f2f2", edge: "#d8d6d5" },
};

/** People's initials' colours (the app's `avatar-*` tokens, as hex), picked by the first letter as AvatarFallback does. */
const AVATAR_COLORS = ["#925651", "#83623a", "#456f4e", "#356d73", "#486491", "#785480"];

export function avatarColor(name: string) {
  return AVATAR_COLORS[(name.normalize("NFD").trim().toUpperCase().charCodeAt(0) || 0) % AVATAR_COLORS.length]!;
}

/** `hex` at `alpha` on white: a soft tint where an email client can't blend. */
function tint(hex: string, alpha: number) {
  const channels = [1, 3, 5].map((i) => Math.round(255 + (parseInt(hex.slice(i, i + 2), 16) - 255) * alpha));
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

const SOFT_FILL = "#fafaf9";
const table = { role: "presentation", cellPadding: 0, cellSpacing: 0, border: 0 } as const;

/** A paragraph of the body. */
export function Paragraph({ children }: { children: ReactNode }) {
  return <Text style={{ fontSize: 15, lineHeight: "24px", color: "#44403c", margin: "0 0 16px" }}>{children}</Text>;
}

/**
 * The post an email is about, as on the portal: its votes in a box, its board over its title, its status as the
 * portal's pill. What the sender doesn't know is left out.
 */
export function PostCard({ title, votes, board, status }: { title: string; votes?: number; board?: string; status?: PostStatus }) {
  const pill = status ? STATUS_PILLS[status] : null;
  return (
    <table {...table} width="100%" style={{ backgroundColor: SOFT_FILL, borderRadius: 12, borderCollapse: "separate", margin: "16px 0" }}>
      <tbody>
        <tr>
          {votes !== undefined && (
            <td width={58} style={{ padding: "14px 0 14px 14px", verticalAlign: "middle" }}>
              <table {...table} style={{ borderCollapse: "separate" }}>
                <tbody>
                  <tr>
                    <td
                      align="center"
                      width={44}
                      style={{ width: 44, height: 48, backgroundColor: colors.card, border: "1px solid #e7e5e4", borderRadius: 10, textAlign: "center", verticalAlign: "middle" }}
                    >
                      <span aria-hidden="true" data-skip-in-text="true" style={{ display: "block", fontSize: 9, lineHeight: "12px", color: "#57534e" }}>
                        &#9650;
                      </span>
                      <span style={{ display: "block", fontSize: 14, lineHeight: "18px", fontWeight: 700, color: colors.text }}>
                        {votes}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>
          )}
          <td style={{ padding: 14, verticalAlign: "middle" }}>
            {board && <div style={{ fontSize: 12, lineHeight: "16px", color: colors.muted }}>{board}</div>}
            <div style={{ fontSize: 15, lineHeight: "21px", fontWeight: 600, color: colors.text }}>{title}</div>
          </td>
          {pill && (
            <td align="right" style={{ padding: "14px 14px 14px 0", verticalAlign: "middle", whiteSpace: "nowrap" }}>
              <span
                style={{
                  display: "inline-block",
                  fontSize: 12,
                  lineHeight: "16px",
                  fontWeight: 600,
                  padding: "3px 10px",
                  borderRadius: 999,
                  border: `1px solid ${pill.edge}`,
                  backgroundColor: pill.fill,
                  color: pill.color,
                  whiteSpace: "nowrap",
                }}
              >
                <span aria-hidden="true" data-skip-in-text="true">&#9679;&nbsp;</span>
                {pill.label}
              </span>
            </td>
          )}
        </tr>
      </tbody>
    </table>
  );
}

/**
 * Someone's message: their initial in their avatar colour, their name and, for the team's, "<Project> team" tinted in
 * the accent; then the text in a soft rounded fill.
 */
export function Message({ name, team, accent, children }: { name: string; team?: string; accent?: string | null; children?: ReactNode }) {
  const link = accentColors(accent).link;
  return (
    <>
      <table {...table} style={{ margin: "18px 0 8px", borderCollapse: "separate" }}>
        <tbody>
          <tr>
            <td
              aria-hidden="true"
              data-skip-in-text="true"
              align="center"
              width={24}
              height={24}
              style={{ width: 24, height: 24, borderRadius: 999, backgroundColor: avatarColor(name), color: "#ffffff", fontSize: 12, fontWeight: 700, lineHeight: "24px", textAlign: "center" }}
            >
              {[...name.trim()][0]?.toUpperCase() ?? ""}
            </td>
            <td style={{ paddingLeft: 8, fontSize: 14, lineHeight: "20px", fontWeight: 600, color: colors.text, verticalAlign: "middle" }}>
              {name}
              {team && (
                <>
                  {" "}
                  <span style={{ display: "inline-block", marginLeft: 4, fontSize: 12, lineHeight: "16px", fontWeight: 600, padding: "1px 8px", borderRadius: 999, backgroundColor: tint(link, 0.1), color: link }}>
                    {team}
                  </span>
                </>
              )}
            </td>
          </tr>
        </tbody>
      </table>
      {children && (
        <Text style={{ fontSize: 15, lineHeight: "24px", color: colors.text, whiteSpace: "pre-wrap", backgroundColor: SOFT_FILL, borderRadius: 12, padding: "14px 16px", margin: "0 0 16px" }}>
          {children}
        </Text>
      )}
    </>
  );
}
