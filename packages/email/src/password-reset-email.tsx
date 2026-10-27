import { Button, Text } from "@react-email/components";

import { colors, Layout } from "./layout";

/** `siteName` is where it was asked for: a portal's project name, or Tuti for the app. */
type PasswordResetProps = { siteName: string; url: string; minutes: number };

export function PasswordResetEmail({ siteName, url, minutes }: PasswordResetProps) {
  return (
    <Layout preview={`Set a new password for ${siteName}.`}>
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>
        Someone asked to reset the password for your account on <strong>{siteName}</strong>.
      </Text>
      <Button
        href={url}
        style={{ backgroundColor: colors.green, color: colors.onGreen, borderRadius: 10, padding: "12px 20px", fontSize: 15, fontWeight: 600 }}
      >
        Set a new password
      </Button>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        The link works once and expires in {minutes} minutes. If you didn&apos;t ask for this, ignore it: your password
        stays the same.
      </Text>
    </Layout>
  );
}

export const passwordResetEmail = (props: PasswordResetProps) => ({
  subject: "Reset your password",
  body: <PasswordResetEmail {...props} />,
});

export function PasswordChangedEmail() {
  return (
    <Layout preview="Your password was just changed.">
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>
        The password for your account was just changed with a reset link, and you were signed out everywhere else.
      </Text>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        If this wasn&apos;t you, use &quot;Forgot your password?&quot; on the sign-in page to set a new one right away.
      </Text>
    </Layout>
  );
}

export const passwordChangedEmail = () => ({
  subject: "Your password was changed",
  body: <PasswordChangedEmail />,
});
