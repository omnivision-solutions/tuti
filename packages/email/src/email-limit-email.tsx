import { Text } from "@react-email/components";

import { Buttons, Eyebrow, Layout, Note, textStyle, Title } from "./layout";

type EmailLimitProps = {
  projectName: string;
  /** The project's plan's name, and how many emails it sends a month. */
  planName: string;
  /** The limit is a free trial's own allowance: "its Pro trial includes". */
  trial?: boolean;
  limit: number;
  /** When the month resets, as the email says it: "December 1". */
  resets: string;
  /** "Upgrade to Pro for more." or "". */
  upgrade: string;
  /** The project's Settings → Billing. */
  url: string;
};

/** To a project's owners and admins, once a month: it reached its plan's monthly email limit (packages/jobs/src/email-limits.ts). */
export function EmailLimitEmail({ projectName, planName, trial = false, limit, resets, upgrade, url }: EmailLimitProps) {
  return (
    <Layout
      label="Billing"
      preview={`${projectName}'s email to its users is waiting until ${resets}.`}
      footer={
        <>
          You get this as an owner or admin of {projectName}, once a month at most.
        </>
      }
    >
      <Eyebrow>{projectName} · Billing</Eyebrow>
      <Title>
        You&apos;ve sent all {limit.toLocaleString("en")} {limit === 1 ? "email" : "emails"} this month
      </Title>
      <Text style={textStyle}>
        <strong>{projectName}</strong> has sent the {limit.toLocaleString("en")} {limit === 1 ? "email" : "emails"} its {planName} {trial ? "trial" : "plan"} includes this month. Nothing is
        lost: replies still show in the inbox and the widget.
      </Text>
      <Note kind="warn">
        Email to your users (support replies, &quot;it shipped&quot; and changelog emails) is waiting until the month resets on <strong>{resets}</strong>.
        {upgrade && ` ${upgrade}`}
      </Note>
      <Buttons href={url} label="See Billing" />
    </Layout>
  );
}

export const emailLimitEmail = (props: EmailLimitProps) => ({
  subject: `${props.projectName} reached its monthly email limit`,
  body: <EmailLimitEmail {...props} />,
});
