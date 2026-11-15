import { Button } from "@react-email/components";

import { Paragraph } from "./blocks";
import { buttonStyle, type EmailBrand, Eyebrow, Layout, Title } from "./layout";

/** `optedOut`: the address has turned all of the project's emails off, which wins until they turn them back on. */
type ChangelogConfirmProps = EmailBrand & { url: string; optedOut?: boolean };

/**
 * "Get updates by email" on a portal's changelog: nothing is sent until they confirm. To an address that's turned all
 * of the project's emails off, it promises nothing: it says so, and the link turns them back on.
 */
export function ChangelogConfirmEmail({ projectName, url, optedOut = false, accent, poweredBy }: ChangelogConfirmProps) {
  return (
    <Layout
      preview={optedOut ? `You've turned off ${projectName}'s emails.` : `Confirm to get ${projectName}'s updates by email.`}
      project={{ projectName, accent, poweredBy }}
      footer={<>If you didn&apos;t ask for this, ignore it: you won&apos;t get anything.</>}
    >
      <Eyebrow accent={accent}>One more step</Eyebrow>
      <Title>{optedOut ? `Turn ${projectName}'s emails back on` : "Confirm your subscription"}</Title>
      <Paragraph>
        {optedOut ? (
          <>
            You asked for <strong>{projectName}</strong>&apos;s changelog by email, but you&apos;ve turned off all of{" "}
            {projectName}&apos;s emails, so nothing is sent to you until you turn them back on.
          </>
        ) : (
          <>
            Confirm to get the changelog entries <strong>{projectName}</strong> emails to subscribers: what&apos;s new,
            improved and fixed.
          </>
        )}
      </Paragraph>
      <Button
        href={url}
        style={buttonStyle(accent)}
      >
        {optedOut ? `Turn ${projectName}'s emails back on` : "Confirm subscription"}
      </Button>
    </Layout>
  );
}

export const changelogConfirmEmail = (props: ChangelogConfirmProps) => ({
  subject: props.optedOut ? `Turn ${props.projectName}'s emails back on?` : `Confirm ${props.projectName}'s updates by email`,
  body: <ChangelogConfirmEmail {...props} />,
});
