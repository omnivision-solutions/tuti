import { Button, Text } from "@react-email/components";

import { buttonStyle, colors, Layout } from "./layout";

type SignInLinkProps = { projectName: string; url: string; minutes: number; accent?: string | null };

export function SignInLinkEmail({ projectName, url, minutes, accent }: SignInLinkProps) {
  return (
    <Layout preview={`Your sign-in link for ${projectName}.`} accent={accent}>
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
        The link works once and expires in {minutes} minutes. If you didn&apos;t ask for this, ignore it.
      </Text>
    </Layout>
  );
}

export const signInLinkEmail = (props: SignInLinkProps) => ({
  subject: `Sign in to ${props.projectName}`,
  body: <SignInLinkEmail {...props} />,
});
