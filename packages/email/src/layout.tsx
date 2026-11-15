import { Body, Column, Container, Head, Heading, Html, Img, Link, Preview, Row, Section, Text } from "@react-email/components";
import { readableOn, SURFACES, textColorOn } from "@tuti/shared/colors";
import type { ReactNode } from "react";

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
 * whether "Powered by tuti" ends it (false only where the portal hides it too: emailBrand in @tuti/jobs).
 */
export type EmailBrand = { projectName: string; accent?: string | null; poweredBy?: boolean };

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
  return <Text style={{ fontSize: 13, fontWeight: 600, color: accentColors(accent).link, margin: "16px 0 8px" }}>{children}</Text>;
}

/** The email's title in the card. */
export function Title({ children }: { children: ReactNode }) {
  return <Heading as="h1" style={{ fontSize: 24, lineHeight: "30px", letterSpacing: -0.5, fontWeight: 700, color: colors.text, margin: "16px 0 10px" }}>{children}</Heading>;
}

/** A tinted box for an aside (`muted`) or a warning (`warn`). */
export function Note({ kind = "muted", children }: { kind?: "muted" | "warn"; children: ReactNode }) {
  const [backgroundColor, color] = kind === "warn" ? ["#fff4ea", colors.onHighlight] : ["#fafaf9", "#57534e"];
  return <Text style={{ fontSize: 14, lineHeight: "22px", padding: "12px 14px", borderRadius: 10, backgroundColor, color, margin: "16px 0" }}>{children}</Text>;
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
 *   unless the project hides it (EmailBrand). Uploaded logos aren't shown: they're stored as WebP, which many email
 *   clients don't show.
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
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: team ? colors.page : "#f5f5f4", fontFamily: team ? `Figtree, ${SANS}` : `Inter, ${SANS}`, margin: 0 }}>
        <Container style={{ maxWidth: 560, margin: "0 auto", padding: "28px 12px 32px" }}>
          <Row style={{ margin: "0 0 16px" }}>
            {project ? (
              <>
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
                          {[...project.projectName.trim()][0]?.toUpperCase() ?? ""}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </Column>
                <Column style={{ verticalAlign: "middle" }}>
                  <Text style={{ fontSize: 16, fontWeight: 650, letterSpacing: -0.2, color: colors.text, lineHeight: "32px", margin: 0 }}>{project.projectName}</Text>
                </Column>
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
