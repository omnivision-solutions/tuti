import { Button, Text } from "@react-email/components";

import { colors, Layout } from "./layout";

type ChangelogConfirmProps = { projectName: string; url: string };

/** "Get updates by email" on a portal's changelog: nothing is sent until they confirm. */
export function ChangelogConfirmEmail({ projectName, url }: ChangelogConfirmProps) {
  return (
    <Layout preview={`Confirm to get ${projectName}'s updates by email.`}>
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>
        Confirm to get <strong>{projectName}</strong>&apos;s changelog by email: what&apos;s new, improved and fixed, as it ships.
      </Text>
      <Button
        href={url}
        style={{ backgroundColor: colors.green, color: colors.onGreen, borderRadius: 10, padding: "12px 20px", fontSize: 15, fontWeight: 600 }}
      >
        Confirm
      </Button>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        If you didn&apos;t ask for this, ignore it: you won&apos;t get anything.
      </Text>
    </Layout>
  );
}

export const changelogConfirmEmail = (props: ChangelogConfirmProps) => ({
  subject: `Confirm ${props.projectName}'s updates by email`,
  body: <ChangelogConfirmEmail {...props} />,
});
