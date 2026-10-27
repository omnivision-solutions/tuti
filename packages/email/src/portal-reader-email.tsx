import { Button, Text } from "@react-email/components";

import { colors, Layout } from "./layout";

type PortalReaderProps = { inviterName: string; projectName: string; email: string; url: string };

/** To someone the team added as a reader of its private portal: where to sign in, and with which address. */
export function PortalReaderEmail({ inviterName, projectName, email, url }: PortalReaderProps) {
  return (
    <Layout preview={`You can now read ${projectName}'s portal.`}>
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>
        {inviterName} gave you access to <strong>{projectName}</strong>&apos;s portal: its docs, changelog and feedback.
      </Text>
      <Button
        href={url}
        style={{ backgroundColor: colors.green, color: colors.onGreen, borderRadius: 10, padding: "12px 20px", fontSize: 15, fontWeight: 600 }}
      >
        Open the portal
      </Button>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        Sign in as {email}: &ldquo;Email me a sign-in link&rdquo; works even if you don&apos;t have an account yet. If you
        weren&apos;t expecting this, you can ignore this email.
      </Text>
    </Layout>
  );
}

export const portalReaderEmail = (props: PortalReaderProps) => ({
  subject: `${props.inviterName} gave you access to ${props.projectName}`,
  body: <PortalReaderEmail {...props} />,
});
