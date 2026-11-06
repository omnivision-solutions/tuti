import { Button, Link, Text } from "@react-email/components";

import { colors, Layout } from "./layout";

const body = { fontSize: 15, color: colors.text, lineHeight: "24px" };
const label = { fontSize: 13, color: colors.muted, lineHeight: "20px", margin: "16px 0 0" };
const value = { ...body, margin: "4px 0 0", whiteSpace: "pre-line" as const };

type EmailDomainTestProps = { projectName: string; address: string };

/** To an admin who asked for it on Settings → Inbox and email: the team's own address sends (docs/plan.md, Support inbox, item 11). */
export function EmailDomainTestEmail({ projectName, address }: EmailDomainTestProps) {
  return (
    <Layout preview={`Replies from ${projectName}'s support inbox now come from ${address}.`}>
      <Text style={body}>
        This is a test from {projectName}&apos;s support inbox. It came from <strong>{address}</strong>, as your replies to your users do now.
      </Text>
    </Layout>
  );
}

export const emailDomainTestEmail = (props: EmailDomainTestProps) => ({
  subject: `A test from ${props.address}`,
  body: <EmailDomainTestEmail {...props} />,
});
