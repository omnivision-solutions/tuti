import { Button, Text } from "@react-email/components";

import { colors, Layout } from "./layout";

const buttonStyle = { backgroundColor: colors.green, color: "#ffffff", borderRadius: 10, padding: "12px 20px", fontSize: 15, fontWeight: 600 };

type PausedProps = {
  projectName: string;
  /** Why: its bounces or complaints (packages/jobs/src/email-limits.ts). */
  reason: string;
};

/** To the server's operator: a project's email was paused, with the link that resumes it. */
export function EmailPausedEmail({ projectName, reason, portalUrl, url }: PausedProps & { portalUrl: string; url: string }) {
  return (
    <Layout preview={`${projectName}'s email to its users is paused.`}>
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>
        <strong>{projectName}</strong> ({portalUrl}) can&apos;t email its users for now: {reason}. Only sign-in links go till you
        resume it; then its held replies go, and its held changelog and post emails don&apos;t. Its team was told.
      </Text>
      <Button href={url} style={buttonStyle}>
        Review
      </Button>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        You get this as this server&apos;s operator (APP_PORTAL_OWNER). The link works for as long as this pause lasts.
      </Text>
    </Layout>
  );
}

export const emailPausedEmail = (props: PausedProps & { portalUrl: string; url: string }) => ({
  subject: `${props.projectName}'s email is paused`,
  body: <EmailPausedEmail {...props} />,
});

/** What the team is told of a pause (its email, Settings → Inbox and email), from its reason: bounces or complaints. */
export const pausedNotice = (reason: string) =>
  `Email sending is paused because of ${reason.includes("spam") ? "too many spam reports" : "a high bounce rate"}. An admin needs to review it before sending can be enabled again.`;

/** To the project's owners and admins: its email was paused, and what that means. */
export function EmailPausedTeamEmail({ projectName, reason, url }: PausedProps & { url: string }) {
  return (
    <Layout preview={`Email sending for ${projectName} is paused.`}>
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>
        {pausedNotice(reason)} If you know what happened, reply to this email.
      </Text>
      <Button href={url} style={buttonStyle}>
        Open settings
      </Button>
    </Layout>
  );
}

export const emailPausedTeamEmail = (props: PausedProps & { url: string }) => ({
  subject: `Email sending for ${props.projectName} is paused`,
  body: <EmailPausedTeamEmail {...props} />,
});
