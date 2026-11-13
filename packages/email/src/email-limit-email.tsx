import { Button, Text } from "@react-email/components";

import { colors, Layout } from "./layout";

type EmailLimitProps = {
  projectName: string;
  /** The project's plan's name, and how many emails it sends a month. */
  planName: string;
  limit: number;
  /** When the month resets, as the email says it: "December 1". */
  resets: string;
  /** "Upgrade to Pro for more." or "". */
  upgrade: string;
  /** The project's Settings → Billing. */
  url: string;
};

/** To a project's owners and admins, once a month: it reached its plan's monthly email limit (packages/jobs/src/email-limits.ts). */
export function EmailLimitEmail({ projectName, planName, limit, resets, upgrade, url }: EmailLimitProps) {
  return (
    <Layout preview={`${projectName}'s email to its users is waiting until ${resets}.`}>
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>
        <strong>{projectName}</strong> has sent the {limit.toLocaleString("en")} emails its {planName} plan includes this month, so its email to
        your users (support replies, &quot;it shipped&quot; and changelog emails) is waiting until the month resets on {resets}. Nothing is lost:
        replies still show in the inbox and the widget.{upgrade && ` ${upgrade}`}
      </Text>
      <Button
        href={url}
        style={{ backgroundColor: colors.green, color: colors.onGreen, borderRadius: 10, padding: "12px 20px", fontSize: 15, fontWeight: 600 }}
      >
        See Billing
      </Button>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        You get this as an owner or admin of {projectName}, once a month at most.
      </Text>
    </Layout>
  );
}

export const emailLimitEmail = (props: EmailLimitProps) => ({
  subject: `${props.projectName} reached its monthly email limit`,
  body: <EmailLimitEmail {...props} />,
});
