import { Button } from "@react-email/components";

import { Paragraph } from "./blocks";
import { buttonStyle, type EmailBrand, Layout, Note, Title } from "./layout";

/** `fromTuti`: Tuti's own (the mobile app's sign-in), with Tuti's header; otherwise a portal's, on its behalf. */
type SignInLinkProps = EmailBrand & { url: string; minutes: number; fromTuti?: boolean };

export function SignInLinkEmail({ projectName, url, minutes, accent, poweredBy, logo, logoText, fromTuti }: SignInLinkProps) {
  return (
    <Layout
      preview={`Your sign-in link for ${projectName}.`}
      project={fromTuti ? undefined : { projectName, accent, poweredBy, logo, logoText }}
      footer={<>If you didn&apos;t ask for this, ignore it.</>}
    >
      <Title>Sign in to {projectName}</Title>
      <Paragraph>Here&apos;s your link to sign in to {projectName}.</Paragraph>
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
