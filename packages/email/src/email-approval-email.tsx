import { Button, Text } from "@react-email/components";

import { colors, Layout } from "./layout";

type ApprovalProps = {
  projectName: string;
  /** Its portal, to look at before approving. */
  portalUrl: string;
  /** Who asked: their name and address. */
  requestedBy: string;
  /** The approval page (opening it changes nothing; its button approves). */
  url: string;
};

/** To the server's operator: a project asks to email its users from the support inbox (docs/plan.md, Support inbox, "Sending"). */
export function EmailApprovalEmail({ projectName, portalUrl, requestedBy, url }: ApprovalProps) {
  return (
    <Layout preview={`${projectName} asks to email its users from the support inbox.`}>
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px" }}>
        <strong>{projectName}</strong> ({portalUrl}) asks to email its users replies from the support inbox. {requestedBy} asked.
        Until you approve it, its replies reach its users only in the widget.
      </Text>
      <Button
        href={url}
        style={{ backgroundColor: colors.green, color: "#ffffff", borderRadius: 10, padding: "12px 20px", fontSize: 15, fontWeight: 600 }}
      >
        Review
      </Button>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        You get this as this server's operator (APP_PORTAL_OWNER). The link works for 7 days.
      </Text>
    </Layout>
  );
}

export const emailApprovalEmail = (props: ApprovalProps) => ({
  subject: `${props.projectName} asks to email its users`,
  body: <EmailApprovalEmail {...props} />,
});
