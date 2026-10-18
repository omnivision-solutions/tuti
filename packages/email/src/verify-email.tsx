import { Button, Text } from "@react-email/components";

import { colors, Layout } from "./layout";

export const verifyEmailSubject = "Verify your email for Tuti";

export function VerifyEmail({ name, url }: { name: string; url: string }) {
  return (
    <Layout preview="Confirm your email address to finish setting up your account.">
      <Text style={{ fontSize: 16, color: colors.text }}>Hi {name},</Text>
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>
        Confirm that this is your email address. Teams can then invite you by email.
      </Text>
      <Button
        href={url}
        style={{ backgroundColor: colors.green, color: "#ffffff", borderRadius: 10, padding: "12px 20px", fontSize: 15, fontWeight: 600 }}
      >
        Verify email
      </Button>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        The link works for 24 hours. If you didn&apos;t sign up for Tuti, you can ignore this email.
      </Text>
    </Layout>
  );
}

export const verifyEmail = (props: { name: string; url: string }) => ({
  subject: verifyEmailSubject,
  body: <VerifyEmail {...props} />,
});
