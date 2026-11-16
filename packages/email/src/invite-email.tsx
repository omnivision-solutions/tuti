import { Text } from "@react-email/components";

import { Buttons, Eyebrow, Layout, textStyle, Title } from "./layout";

type InviteProps = { inviterName: string; projectName: string; roleLabel: string; url: string };

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

export function InviteEmail({ inviterName, projectName, roleLabel, url }: InviteProps) {
  return (
    <Layout
      preview={`Join ${projectName} on Tuti.`}
      footer={
        <>
          The invite works once and expires in 7 days. If you weren&apos;t expecting it, you can ignore this email.
        </>
      }
    >
      <Eyebrow>You&apos;re invited</Eyebrow>
      <Title>Join {projectName} on Tuti</Title>
      <Text style={textStyle}>
        <strong>{inviterName}</strong> invited you to join {projectName} on Tuti as {article(roleLabel)} <strong>{roleLabel.toLowerCase()}</strong>: feedback,
        roadmap, changelog and help center in one place.
      </Text>
      <Buttons href={url} label="Accept the invite" />
    </Layout>
  );
}

export const inviteEmail = (props: InviteProps) => ({
  subject: `${props.inviterName} invited you to ${props.projectName} on Tuti`,
  body: <InviteEmail {...props} />,
});
