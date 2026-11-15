import { Button, Text } from "@react-email/components";

import { buttonStyle, colors, type EmailBrand, Layout } from "./layout";

type SignInLinkProps = EmailBrand & { url: string; minutes: number };

export function SignInLinkEmail({ projectName, url, minutes, accent, poweredBy }: SignInLinkProps) {
  return (
    <Layout
      preview={`Your sign-in link for ${projectName}.`}
      project={{ projectName, accent, poweredBy }}
      footer={<>If you didn&apos;t ask for this, ignore it.</>}
    >
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>
        Here&apos;s your link to sign in to <strong>{projectName}</strong>.
      </Text>
      <Button
        href={url}
        style={buttonStyle(accent)}
      >
        Sign in
      </Button>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        The link works once and expires in {minutes} minutes.
      </Text>
    </Layout>
  );
}

export const signInLinkEmail = (props: SignInLinkProps) => ({
  subject: `Sign in to ${props.projectName}`,
  body: <SignInLinkEmail {...props} />,
});
