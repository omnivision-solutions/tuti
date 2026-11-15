import { Button, Text } from "@react-email/components";

import { buttonStyle, colors, type EmailBrand, Layout } from "./layout";

/** `project`: the portal it was asked on (sent on its behalf); none for the app (from Tuti). */
type PasswordResetProps = { project?: EmailBrand | null; url: string; minutes: number };

export function PasswordResetEmail({ project, url, minutes }: PasswordResetProps) {
  const siteName = project?.projectName ?? "Tuti";
  return (
    <Layout
      preview={`Set a new password for ${siteName}.`}
      project={project ?? undefined}
      footer={<>If you didn&apos;t ask for this, ignore it: your password stays the same.</>}
    >
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>
        Someone asked to reset the password for your account on <strong>{siteName}</strong>.
      </Text>
      <Button
        href={url}
        style={buttonStyle(project?.accent)}
      >
        Set a new password
      </Button>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        The link works once and expires in {minutes} minutes.
      </Text>
    </Layout>
  );
}

export const passwordResetEmail = (props: PasswordResetProps) => ({
  subject: "Reset your password",
  body: <PasswordResetEmail {...props} />,
});

/** `project`: the portal the reset was asked on (sent on its behalf); none for the app. */
export function PasswordChangedEmail({ project }: { project?: EmailBrand | null }) {
  return (
    <Layout preview="Your password was just changed." project={project ?? undefined}>
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>
        The password for your account was just changed with a reset link, and you were signed out everywhere else.
      </Text>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        If this wasn&apos;t you, use &quot;Forgot your password?&quot; on the sign-in page to set a new one right away.
      </Text>
    </Layout>
  );
}

export const passwordChangedEmail = (project?: EmailBrand | null) => ({
  subject: "Your password was changed",
  body: <PasswordChangedEmail project={project} />,
});
