import { Text } from "@react-email/components";

import { Buttons, Layout, textStyle, Title } from "./layout";

export const verifyEmailSubject = "Verify your email for Tuti";

export function VerifyEmail({ name, url }: { name: string; url: string }) {
  return (
    <Layout
      preview="Confirm your email address to finish signing up."
      footer={
        <>
          The link works for 24 hours. If you didn&apos;t sign up for Tuti, you can ignore this email.
        </>
      }
    >
      {/* Sent on signing up on the app or a portal, and again on Resend, maybe months later: no welcome. */}
      <Title>Confirm your email, {name}</Title>
      <Text style={textStyle}>Confirm this is your email to finish signing up.</Text>
      <Buttons href={url} label="Verify my email" />
    </Layout>
  );
}

export const verifyEmail = (props: { name: string; url: string }) => ({
  subject: verifyEmailSubject,
  body: <VerifyEmail {...props} />,
});
