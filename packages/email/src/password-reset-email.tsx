import { Button } from "@react-email/components";

import { Paragraph } from "./blocks";
import { buttonStyle, type EmailBrand, Layout, Note, Title } from "./layout";

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
      <Title>Reset your password</Title>
      <Paragraph>
        Someone asked to reset the password for your account on <strong>{siteName}</strong>.
      </Paragraph>
      <Button
        href={url}
        style={buttonStyle(project?.accent)}
      >
        Set a new password
      </Button>
      <Note>The link works once and expires in {minutes} minutes.</Note>
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
      <Title>Your password was changed</Title>
      <Paragraph>The password for your account was just changed with a reset link, and you were signed out everywhere else.</Paragraph>
      <Note kind="warn">If this wasn&apos;t you, use &quot;Forgot your password?&quot; on the sign-in page to set a new one right away.</Note>
    </Layout>
  );
}

export const passwordChangedEmail = (project?: EmailBrand | null) => ({
  subject: "Your password was changed",
  body: <PasswordChangedEmail project={project} />,
});
