import { Button } from "@react-email/components";

import { Paragraph } from "./blocks";
import { buttonStyle, type EmailBrand, Eyebrow, Layout, Note, Title } from "./layout";

type PortalReaderProps = EmailBrand & { inviterName: string; email: string; url: string };

/** To someone the team added as a reader of its private portal: where to sign in, and with which address. */
export function PortalReaderEmail({ inviterName, projectName, email, url, accent, poweredBy }: PortalReaderProps) {
  return (
    <Layout
      preview={`You can now read ${projectName}'s portal.`}
      project={{ projectName, accent, poweredBy }}
      footer={<>If you weren&apos;t expecting this, you can ignore this email.</>}
    >
      <Eyebrow accent={accent}>You&apos;re invited</Eyebrow>
      <Title>
        {inviterName} gave you access to {projectName}&apos;s portal
      </Title>
      <Paragraph>Read the docs, follow the changelog and share feedback with the {projectName} team.</Paragraph>
      <Button
        href={url}
        style={buttonStyle(accent)}
      >
        Open the portal
      </Button>
      <Note>
        Sign in as <strong>{email}</strong>. &ldquo;Email me a sign-in link&rdquo; works even if you don&apos;t have an account yet.
      </Note>
    </Layout>
  );
}

export const portalReaderEmail = (props: PortalReaderProps) => ({
  subject: `${props.inviterName} gave you access to ${props.projectName}`,
  body: <PortalReaderEmail {...props} />,
});
