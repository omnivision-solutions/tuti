import { Text } from "@react-email/components";

import { colors, Layout } from "./layout";

type ReplyProps = {
  projectName: string;
  /** The team's messages they haven't seen, oldest first. */
  messages: { name: string; body: string }[];
};

/** To a user: the team's replies in the support inbox that they haven't seen (docs/plan.md, Support inbox, "Reaching the user"). */
export function ConversationReplyEmail({ projectName, messages }: ReplyProps) {
  return (
    <Layout preview={messages[0]?.body.slice(0, 120) ?? ""}>
      {messages.map((message, i) => (
        <div key={i}>
          <Text style={{ fontSize: 13, color: colors.muted, margin: "16px 0 4px" }}>{message.name}</Text>
          <Text style={{ fontSize: 15, color: colors.text, lineHeight: "24px", whiteSpace: "pre-wrap", margin: 0 }}>{message.body}</Text>
        </div>
      ))}
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        Reply to this email to answer {projectName}.
      </Text>
    </Layout>
  );
}

export const conversationReplyEmail = (props: ReplyProps & { subject: string }) => ({
  subject: /^re:/i.test(props.subject) ? props.subject : `Re: ${props.subject}`,
  body: <ConversationReplyEmail projectName={props.projectName} messages={props.messages} />,
});
