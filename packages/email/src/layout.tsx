import { Body, Container, Head, Html, Preview, Section, Text } from "@react-email/components";
import type { ReactNode } from "react";

// Brand colours: the light theme tokens in apps/web/src/app/globals.css, as hex.
export const colors = { green: "#12804a", text: "#1c1917", muted: "#78716c", border: "#ece7dd", page: "#fffdf8" };

/** The frame every Tuti email shares. */
export function Layout({ preview, children }: { preview: string; children: ReactNode }) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: colors.page, fontFamily: "Figtree, -apple-system, Segoe UI, sans-serif", margin: 0 }}>
        <Container style={{ maxWidth: 480, margin: "0 auto", padding: "32px 24px" }}>
          <Text style={{ fontSize: 20, fontWeight: 700, color: colors.green, margin: "0 0 24px" }}>tuti</Text>
          <Section
            style={{ backgroundColor: "#ffffff", border: `1px solid ${colors.border}`, borderRadius: 14, padding: "8px 24px 24px" }}
          >
            {children}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
