import { Text } from "@react-email/components";

import { colors, type EmailBrand, Layout } from "./layout";

type ReplyProps = EmailBrand & {
  /** The team's messages they haven't seen, oldest first. */
  messages: { name: string; body: string }[];
};

/** To a user: the team's replies in the support inbox that they haven't seen (docs/plan.md, Support inbox, "Reaching the user"). */
export function ConversationReplyEmail({ projectName, messages, accent, poweredBy }: ReplyProps) {
  return (
    <Layout preview={messages[0]?.body.slice(0, 120) ?? ""} project={{ projectName, accent, poweredBy }} footer={<>Reply to this email to answer {projectName}.</>}>
      {messages.map((message, i) => (
        <div key={i}>
          <Text style={{ fontSize: 13, color: colors.muted, margin: "16px 0 4px" }}>{message.name}</Text>
          <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px", whiteSpace: "pre-wrap", margin: 0 }}>{message.body}</Text>
        </div>
      ))}
    </Layout>
  );
}

export const conversationReplyEmail = (props: ReplyProps & { subject: string }) => ({
  subject: /^re:/i.test(props.subject) ? props.subject : `Re: ${props.subject}`,
  body: <ConversationReplyEmail projectName={props.projectName} messages={props.messages} accent={props.accent} poweredBy={props.poweredBy} />,
});
