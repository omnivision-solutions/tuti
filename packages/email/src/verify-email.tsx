import { Text } from "@react-email/components";

import { Buttons, Layout, textStyle, Title } from "./layout";

export const verifyEmailSubject = "Verify your email for Tuti";

export function VerifyEmail({ name, url }: { name: string; url: string }) {
  return (
    <Layout
      preview="Confirm your email address to finish setting up your account."
      footer={
        <>
          The link works for 24 hours. If you didn&apos;t sign up for Tuti, you can ignore this email.
        </>
      }
    >
      <Title>Welcome to Tuti, {name}</Title>
      <Text style={textStyle}>Confirm that this is your email address to finish setting up your Tuti account.</Text>
      <Buttons href={url} label="Verify my email" />
    </Layout>
  );
}

export const verifyEmail = (props: { name: string; url: string }) => ({
  subject: verifyEmailSubject,
  body: <VerifyEmail {...props} />,
});
