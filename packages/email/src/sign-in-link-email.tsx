import { Button } from "@react-email/components";

import { Paragraph } from "./blocks";
import { buttonStyle, type EmailBrand, Layout, Note, Title } from "./layout";

type SignInLinkProps = EmailBrand & { url: string; minutes: number };

export function SignInLinkEmail({ projectName, url, minutes, accent, poweredBy }: SignInLinkProps) {
  return (
    <Layout
      preview={`Your sign-in link for ${projectName}.`}
      project={{ projectName, accent, poweredBy }}
      footer={<>If you didn&apos;t ask for this, ignore it.</>}
    >
      <Title>Sign in to {projectName}</Title>
      <Paragraph>Here&apos;s your link to sign in to {projectName} and vote, comment and follow ideas.</Paragraph>
      <Button
        href={url}
        style={buttonStyle(accent)}
      >
        Sign in to {projectName}
      </Button>
      <Note>The link works once and expires in {minutes} minutes.</Note>
    </Layout>
  );
}

export const signInLinkEmail = (props: SignInLinkProps) => ({
  subject: `Sign in to ${props.projectName}`,
  body: <SignInLinkEmail {...props} />,
});
