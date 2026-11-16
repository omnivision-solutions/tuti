import { Body, Button, Column, Container, Head, Heading, Html, Img, Link, Preview, Row, Section, Text } from "@react-email/components";
import type { DiffLine } from "@tuti/content";
import { readableOn, SURFACES, textColorOn } from "@tuti/shared/colors";
import { Fragment, type ReactNode } from "react";

// Brand colours: the light theme tokens in packages/ui/src/globals.css, as hex.
export const colors = {
  green: "#12804a",
  onGreen: "#ffffff",
  text: "#1c1917",
  muted: "#78716c",
  mutedBackground: "#f3f0ea",
  border: "#ece7dd",
  page: "#fffdf8",
  card: "#ffffff",
  soft: "#e8f5ec",
  onSoft: "#0f5e37",
  highlight: "#ffe8d6",
  onHighlight: "#9a3b06",
  destructive: "#e7000b",
  /** --destructive at 10% on white, as the app marks removed lines. */
  destructiveSoft: "#fde6e7",
};

/**
 * A project's accent (`Project.brandColor`, `#rrggbb`; null for Tuti's green) in the emails sent on its behalf: the
 * colour, or where it's too faint (under 3:1) the shade of it the portal's light mode uses (readableOn; the text colour
 * for a grey), with black or white text on it; and for text in it (`link`: links at body size) the colour where it reads
 * as text (4.5:1), else that shade. Judged against the portal's light page, as brandCss does, so a project's emails and
 * portal match: the white card is lighter still, so what reads there reads on it.
 */
export function accentColors(accent?: string | null): { accent: string; onAccent: string; link: string } {
  if (!accent || !/^#[0-9a-f]{6}$/i.test(accent)) {
    return { accent: colors.green, onAccent: colors.onGreen, link: colors.green };
  }
  const shown = readableOn(accent, SURFACES.light) ?? colors.text;
  return { accent: shown, onAccent: textColorOn(shown), link: readableOn(accent, SURFACES.light, 4.5) ?? colors.text };
}

/** The main button's style, in the project's accent (accentColors). */
export function buttonStyle(accent?: string | null) {
  const { accent: backgroundColor, onAccent: color } = accentColors(accent);
  return { backgroundColor, color, borderRadius: 10, padding: "12px 20px", fontSize: 15, fontWeight: 600 };
}

/** A second button beside the main one: quiet, in the text colour. */
export const secondaryButtonStyle = { backgroundColor: "#f5f5f4", color: colors.text, borderRadius: 10, padding: "12px 20px", fontSize: 15, fontWeight: 600 };

/**
 * How an email sent on a project's behalf shows it: its name, its accent (Project.brandColor; null for Tuti's green) and
 * whether "Powered by tuti" ends it (false only where the portal hides it too: emailBrand in @tuti/jobs), and its
 * portal's logo (an uploaded WebP) and the text beside it (Project.logoText).
 */
export type EmailBrand = {
  projectName: string;
  accent?: string | null;
  poweredBy?: boolean;
  logo?: { url: string; width: number; height: number } | null;
  logoText?: string;
};

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);

/** The logo at the portal header's size: 32px tall, at most 160px wide. */
function logoSize({ width, height }: { width: number; height: number }) {
  const w = Math.min(160, Math.round((width * 32) / height));
  return { w, h: Math.round((w * height) / width) };
}

/**
 * Tuti's own images, from the app's public files (an email can't show an SVG): none without APP_URL, or with one that
 * isn't a URL (the words instead: an email never fails over its picture).
 */
const appImage = (file: string) => {
  const base = process.env.APP_URL;
  return base && URL.canParse(base) ? new URL(`/api/${file}`, base).href : null;
};

/** Where "Powered by tuti" goes, on every installation, self-hosted too: no project or installation in it. */
export const POWERED_BY_URL = "https://tuti.so/?utm_source=email&utm_medium=powered_by&utm_campaign=badge";

const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** The small line over a title (what the email is about), in the accent. */
export function Eyebrow({ accent, children }: { accent?: string | null; children: ReactNode }) {
  return <Text style={{ fontSize: 13, fontWeight: 600, color: accentColors(accent).link, margin: "16px 0 8px", ...wraps }}>{children}</Text>;
}

/** Long words in user content (a title, a URL, a repository's name) wrap, so a phone's card never scrolls sideways. */
export const wraps = { overflowWrap: "anywhere", wordBreak: "break-word" } as const;

/** The email's title in the card. */
export function Title({ children }: { children: ReactNode }) {
  return <Heading as="h1" style={{ fontSize: 24, lineHeight: "30px", letterSpacing: -0.5, fontWeight: 700, color: colors.text, margin: "16px 0 10px", ...wraps }}>{children}</Heading>;
}

/** A tinted box for an aside (`muted`) or a warning (`warn`). */
export function Note({ kind = "muted", children }: { kind?: "muted" | "warn"; children: ReactNode }) {
  const [backgroundColor, color] = kind === "warn" ? ["#fff4ea", colors.onHighlight] : ["#fafaf9", "#57534e"];
  return <Text style={{ fontSize: 14, lineHeight: "22px", padding: "12px 14px", borderRadius: 10, backgroundColor, color, margin: "16px 0", ...wraps }}>{children}</Text>;
}

/** A paragraph in the card. */
export const textStyle = { fontSize: 15, lineHeight: "24px", color: "#44403c", margin: "0 0 16px" };

/** A soft fill under a tile, a message or a diff's unchanged line. */
const SOFT_FILL = "#fafaf9";

/** The main button, and a second one (a grey fill) beside it: a table, so they sit side by side in every client. */
export function Buttons({ href, label, second, small = false }: { href: string; label: string; second?: { href: string; label: string }; small?: boolean }) {
  // A long label ("Publish org/repo#848 now") may break anywhere, so two buttons side by side still fit a phone's card.
  const size = { ...(small ? { padding: "8px 14px", fontSize: 14, borderRadius: 8 } : {}), ...wraps };
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} style={{ margin: small ? "12px 0 0" : "22px 0 4px", borderCollapse: "separate" }}>
      <tbody>
        <tr>
          <td>
            <Button href={href} style={{ ...buttonStyle(), ...size }}>
              {label}
            </Button>
          </td>
          {second && (
            <td style={{ paddingLeft: 10 }}>
              {/* Apart in plain text too, so each link stays whole. */}{" "}
              <Button href={second.href} style={{ ...secondaryButtonStyle, ...size }}>
                {second.label}
              </Button>
            </td>
          )}
        </tr>
      </tbody>
    </table>
  );
}

/** Numbers side by side, each on a soft tile over what it counts ("8", "still true"). */
export function Stats({ items }: { items: { n: number | string; label: string }[] }) {
  // Up to three in a row; four or more two a row (2×2), so a phone's card still fits them (no media queries in email).
  const perRow = items.length > 3 ? 2 : items.length;
  const rows = Array.from({ length: Math.ceil(items.length / perRow) }, (_, r) => items.slice(r * perRow, (r + 1) * perRow));
  return (
    <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ margin: "18px 0", borderCollapse: "separate" }}>
      <tbody>
        {rows.map((row, r) => (
          <Fragment key={r}>
            {/* 10px apart, across and down: spacer cells and rows, as cells take no margin in email. */}
            {r > 0 && (
              <tr>
                <td colSpan={perRow * 2 - 1} height={10} style={{ height: 10, fontSize: 0, lineHeight: "10px" }} />
              </tr>
            )}
            <tr>
              {row.map((item, i) => (
                <Fragment key={i}>
                  {i > 0 && <td width={10} style={{ width: 10 }} />}
                  <td width={`${Math.floor(96 / perRow)}%`} style={{ backgroundColor: SOFT_FILL, borderRadius: 12, padding: "12px 14px", verticalAlign: "top" }}>
                    <Text style={{ fontSize: 13, lineHeight: "18px", color: colors.muted, margin: 0 }}>
                      <span style={{ display: "block", fontSize: 22, lineHeight: "28px", fontWeight: 700, letterSpacing: -0.4, color: colors.text }}>{item.n}</span> {item.label}
                    </Text>
                  </td>
                </Fragment>
              ))}
            </tr>
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

/**
 * An edit as its lines: removed ones struck through on a soft red, added ones on a soft green, unchanged ones on a soft
 * grey, each with its sign (for plain text too, and where the colours don't show).
 */
export function Diff({ lines, more }: { lines: DiffLine[]; more?: number }) {
  const looks = {
    removed: { sign: "−", color: "#7f1d1d", backgroundColor: colors.destructiveSoft, textDecoration: "line-through" },
    added: { sign: "+", color: colors.onSoft, backgroundColor: colors.soft, textDecoration: "none" },
    same: { sign: " ", color: colors.muted, backgroundColor: SOFT_FILL, textDecoration: "none" },
  };
  return (
    <>
      <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ margin: "10px 0 0", borderCollapse: "separate", borderRadius: 10, overflow: "hidden" }}>
        <tbody>
          {lines.map((line, i) => {
            const { sign, ...look } = looks[line.kind];
            return (
              <tr key={i}>
                <td style={{ backgroundColor: look.backgroundColor, padding: "6px 12px" }}>
                  {/* A paragraph: a line of its own in plain text. */}
                  {/* A long word (a URL, a path) wraps, so the line never makes a phone scroll sideways. */}
                  <Text style={{ fontSize: 14, lineHeight: "21px", color: look.color, margin: 0, ...wraps }}>
                    <span style={{ fontWeight: 700, opacity: 0.6 }}>{sign} </span>
                    <span style={{ textDecoration: look.textDecoration }}>{line.text}</span>
                  </Text>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!!more && <Text style={{ fontSize: 13, color: colors.muted, margin: "6px 0 0" }}>{more === 1 ? "1 more line" : `${more} more lines`} in Tuti</Text>}
    </>
  );
}

/**
 * The portal's "Powered by tuti" badge, as a pill under the card: the mark and the drawn wordmark are a picture, grey
 * beside a team's colours (`mono`), in Tuti's own on its emails. A table with rounded corners: where corners aren't
 * supported, a plain bordered box.
 */
function PoweredBy({ mono }: { mono: boolean }) {
  const image = appImage(mono ? "email-powered-by.png" : "email-powered-by-tuti.png");
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} align="center" style={{ margin: "18px auto 0", borderCollapse: "separate" }}>
      <tbody>
        <tr>
          <td style={{ backgroundColor: colors.card, border: "1px solid #e7e5e4", borderRadius: 999, padding: "6px 12px 6px 10px" }}>
            <Link href={POWERED_BY_URL} style={{ color: colors.muted, fontSize: 12, lineHeight: "16px", fontWeight: 500, textDecoration: "none", whiteSpace: "nowrap" }}>
              Powered by&nbsp;{" "}
              {image ? (
                <Img src={image} width={43} height={16} alt="tuti" style={{ display: "inline-block", verticalAlign: "middle", border: 0 }} />
              ) : (
                <strong style={{ color: colors.text }}>tuti</strong>
              )}
            </Link>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * The frame every Tuti email shares: a header, the white card, then under it the reason for the email (`footer`:
 * why they get it, and how to stop) and "Powered by tuti".
 * - Sent on a project's behalf to its customers and readers (`project`): its accent's square with the name's first
 *   letter, and its name, as its portal's header; its accent for buttons and links; a neutral page. "Powered by tuti"
 *   unless the project hides it (EmailBrand). With an uploaded logo, the logo and its text instead, as the portal's
 *   header; the logo is WebP, which Outlook for Windows can't show, so there it keeps the letter's square.
 * - From Tuti to a team (no `project`): the parrot and the wordmark, with the part of Tuti it's from (`label`:
 *   "Autopilot") beside them, on Tuti's cream page, and always "Powered by tuti" in Tuti's colours.
 */
export function Layout({
  preview,
  label,
  project,
  footer,
  children,
}: {
  preview: string;
  label?: string;
  project?: EmailBrand;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const team = !project;
  const { accent, onAccent } = accentColors(project?.accent);
  const logo = team ? appImage("email-tuti.png") : null;
  // As the portal's header (PortalLogo): with a logo only its text, if any; without one the text or the project's name.
  const name = project && (project.logo ? project.logoText : project.logoText || project.projectName);
  const initial = [...(project?.logoText || project?.projectName || "").trim()][0]?.toUpperCase() ?? "";
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: team ? colors.page : "#f5f5f4", fontFamily: team ? `Figtree, ${SANS}` : `Inter, ${SANS}`, margin: 0 }}>
        <Container style={{ maxWidth: 560, margin: "0 auto", padding: "28px 12px 32px" }}>
          <Row style={{ margin: "0 0 16px" }}>
            {project ? (
              <>
                {project.logo ? (
                  <Column
                    style={{ width: logoSize(project.logo).w + 10, verticalAlign: "middle" }}
                    // Outlook for Windows can't show WebP: it gets the letter's square, and the name where no text names it (conditional
                    // comments, which React can't write).
                    dangerouslySetInnerHTML={{
                      __html:
                        `<!--[if !mso]><!--><img src="${escapeHtml(project.logo.url)}" width="${logoSize(project.logo).w}" height="${logoSize(project.logo).h}" alt="${project.logoText ? "" : escapeHtml(project.projectName)}" style="display:block;border:0;outline:none"><!--<![endif]-->` +
                        `<!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0"><tr><td aria-hidden="true" width="32" height="32" align="center" style="background-color:${accent};color:${onAccent};font-size:16px;font-weight:700;line-height:32px">${escapeHtml(initial)}</td>${project.logoText ? "" : `<td style="padding-left:10px;font-size:16px;font-weight:650;color:${colors.text};line-height:32px">${escapeHtml(project.projectName)}</td>`}</tr></table><![endif]-->`,
                    }}
                  />
                ) : (
                  <Column style={{ width: 42, verticalAlign: "middle" }}>
                    <table role="presentation" cellPadding={0} cellSpacing={0} style={{ borderCollapse: "separate" }}>
                      <tbody>
                        <tr>
                          <td
                            // The name beside it says it: no "A Acme" for screen readers or in the plain text.
                            aria-hidden="true"
                            data-skip-in-text="true"
                            width={32}
                            height={32}
                            align="center"
                            style={{ width: 32, height: 32, borderRadius: 9, backgroundColor: accent, color: onAccent, fontSize: 16, fontWeight: 700, textAlign: "center", lineHeight: "32px" }}
                          >
                            {initial}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </Column>
                )}
                {name && (
                  <Column style={{ verticalAlign: "middle" }}>
                    <Text style={{ fontSize: 16, fontWeight: 650, letterSpacing: -0.2, color: colors.text, lineHeight: "32px", margin: 0 }}>{name}</Text>
                  </Column>
                )}
              </>
            ) : (
              <>
                <Column style={{ width: logo ? 79 : undefined, verticalAlign: "middle" }}>
                  {logo ? (
                    <Img src={logo} width={69} height={28} alt="tuti" style={{ border: 0 }} />
                  ) : (
                    <Text style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.5, color: colors.green, lineHeight: "28px", margin: 0 }}>tuti</Text>
                  )}
                </Column>
                {label && (
                  <Column style={{ verticalAlign: "middle" }}>
                    <Text style={{ fontSize: 15, fontWeight: 500, color: colors.muted, lineHeight: "28px", margin: "0 0 0 2px" }}>{label}</Text>
                  </Column>
                )}
              </>
            )}
          </Row>
          <Section
            style={{
              backgroundColor: colors.card,
              // The shadow for where it's drawn; the edge for where it isn't (Outlook), so the card never fades into the page.
              border: `1px solid ${colors.border}`,
              borderRadius: 16,
              padding: "8px 28px 28px",
              boxShadow: "0 1px 2px rgba(28,25,23,.06), 0 8px 28px rgba(28,25,23,.06)",
              // Inherited by everything in the card, so any long word (a title, a URL, a repository's name) wraps.
              ...wraps,
            }}
          >
            {children}
          </Section>
          {footer && <Text style={{ fontSize: 13, lineHeight: "20px", color: colors.muted, textAlign: "center", margin: "20px 0 0" }}>{footer}</Text>}
          {(team || project.poweredBy !== false) && <PoweredBy mono={!team} />}
        </Container>
      </Body>
    </Html>
  );
}

/** A link in the footer under the card. */
export function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} style={{ color: "#57534e", textDecoration: "underline" }}>
      {children}
    </Link>
  );
}
