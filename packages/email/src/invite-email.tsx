import { Button, Text } from "@react-email/components";

import { colors, Layout } from "./layout";

type InviteProps = { inviterName: string; projectName: string; roleLabel: string; url: string };

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

export function InviteEmail({ inviterName, projectName, roleLabel, url }: InviteProps) {
  return (
    <Layout preview={`Join ${projectName} on Tuti.`}>
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>
        {inviterName} invited you to join <strong>{projectName}</strong> on Tuti as {article(roleLabel)}{" "}
        {roleLabel.toLowerCase()}.
      </Text>
      <Button
        href={url}
        style={{ backgroundColor: colors.green, color: "#ffffff", borderRadius: 10, padding: "12px 20px", fontSize: 15, fontWeight: 600 }}
      >
        Accept invite
      </Button>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        The invite works once and expires in 7 days. If you weren&apos;t expecting it, you can ignore this email.
      </Text>
    </Layout>
  );
}

export const inviteEmail = (props: InviteProps) => ({
  subject: `${props.inviterName} invited you to ${props.projectName} on Tuti`,
  body: <InviteEmail {...props} />,
});
