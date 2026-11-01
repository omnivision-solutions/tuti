import { Body, Column, Container, Head, Html, Img, Preview, Row, Section, Text } from "@react-email/components";
import type { ReactNode } from "react";

// Brand colours: the light theme tokens in apps/web/src/app/globals.css, as hex.
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

/** The parrot mark, from the app's public files (an email can't show the SVG): none without APP_URL. */
const logoUrl = () => (process.env.APP_URL ? new URL("/email-logo.png", process.env.APP_URL).href : null);

/**
 * The frame every Tuti email shares. Those to a team about Tuti itself name the part of Tuti they're from
 * (`label`: "Autopilot"), with the logo and a line on what Tuti is; those a team's own customers get (on the
 * team's behalf) don't advertise Tuti.
 */
export function Layout({ preview, label, children }: { preview: string; label?: string; children: ReactNode }) {
  const logo = label ? logoUrl() : null;
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: colors.page, fontFamily: "Figtree, -apple-system, Segoe UI, sans-serif", margin: 0 }}>
        <Container style={{ maxWidth: 520, margin: "0 auto", padding: "24px 12px" }}>
          <Row style={{ margin: "0 0 14px" }}>
            {logo && (
              <Column style={{ width: 34, verticalAlign: "middle" }}>
                <Img src={logo} width={28} height={28} alt="" />
              </Column>
            )}
            <Column style={{ verticalAlign: "middle" }}>
              <Text style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.5, color: colors.green, lineHeight: "28px", margin: 0 }}>
                tuti
                {label && <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: 0, color: colors.muted }}> {label}</span>}
              </Text>
            </Column>
          </Row>
          <Section
            style={{ backgroundColor: colors.card, border: `1px solid ${colors.border}`, borderTop: `4px solid ${colors.green}`, borderRadius: 14, padding: "4px 20px 20px" }}
          >
            {children}
          </Section>
          {label && (
            <Text style={{ fontSize: 12, color: colors.muted, textAlign: "center", margin: "16px 0 0" }}>
              <strong style={{ color: colors.green }}>tuti</strong> · feedback, roadmap and changelog
            </Text>
          )}
        </Container>
      </Body>
    </Html>
  );
}
