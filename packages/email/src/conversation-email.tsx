import { Text } from "@react-email/components";

import { Buttons, colors, Eyebrow, Layout, Title } from "./layout";

type ConversationProps = {
  projectName: string;
  /** Who wrote: their name, or their email address when that's all there is. */
  from: string;
  /** A new conversation, rather than a reply in one. */
  isNew: boolean;
  subject: string;
  /** The message, as plain text. */
  body: string;
  /** The conversation in the team's inbox. */
  url: string;
  /** Why they get it: it's assigned to them, or they asked for new conversations. */
  assigned: boolean;
};

/** Longest message quoted in the email; the rest is in the inbox. */
const MAX_QUOTED = 2000;

/** To a project's team: someone wrote in the support inbox (docs/plan.md, Support inbox). */
export function ConversationEmail({ projectName, from, isNew, subject, body, url, assigned }: ConversationProps) {
  const quoted = body.length > MAX_QUOTED ? `${body.slice(0, MAX_QUOTED - 1)}…` : body;
  return (
    <Layout
      preview={`${from}: ${quoted.slice(0, 120)}`}
      label="Inbox"
      footer={
        <>
          {assigned
            ? `You get this because the conversation is assigned to you in ${projectName}.`
            : `You get this because "Email me new conversations" is on for you in ${projectName}'s inbox.`}
        </>
      }
    >
      <Eyebrow>
        {isNew ? "New conversation" : "New reply"} · {projectName}
      </Eyebrow>
      <Title>{subject}</Title>
      <Text style={{ fontSize: 14, color: colors.text, lineHeight: "20px", margin: "18px 0 8px" }}>
        <strong>{from}</strong> <span style={{ color: colors.muted }}>{isNew ? "started a conversation" : "replied"}</span>
      </Text>
      <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px", whiteSpace: "pre-wrap", backgroundColor: "#fafaf9", borderRadius: 12, padding: "14px 16px", margin: 0 }}>
        {quoted}
      </Text>
      <Buttons href={url} label="Reply in the inbox" />
    </Layout>
  );
}

export const conversationEmail = (props: ConversationProps) => ({
  fromName: "Tuti Inbox",
  subject: props.isNew ? `New conversation: ${props.subject}` : `${props.from} replied: ${props.subject}`,
  body: <ConversationEmail {...props} />,
});
