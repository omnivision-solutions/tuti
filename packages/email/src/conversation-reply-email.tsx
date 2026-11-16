import { Message } from "./blocks";
import { type EmailBrand, Layout, Note } from "./layout";

type ReplyProps = EmailBrand & {
  /** The team's messages they haven't seen, oldest first. */
  messages: { name: string; body: string }[];
  /** The conversation's subject, named under the messages. */
  subject?: string;
};

/** To a user: the team's replies in the support inbox that they haven't seen (docs/plan.md, Support inbox, "Reaching the user"). */
export function ConversationReplyEmail({ projectName, messages, subject, accent, poweredBy, logo, logoText }: ReplyProps) {
  return (
    <Layout preview={messages[0]?.body.slice(0, 120) ?? ""} project={{ projectName, accent, poweredBy, logo, logoText }} footer={<>Reply to this email to answer {projectName}.</>}>
      {messages.map((message, i) => (
        // A message with no teammate's name is the project's own: no "Acme Acme team".
        <Message key={i} name={message.name} team={message.name === projectName ? undefined : `${projectName} team`} accent={accent}>
          {message.body}
        </Message>
      ))}
      {subject && (
        <Note>
          Your conversation: <strong>{subject.replace(/^re:\s*/i, "")}</strong>
        </Note>
      )}
    </Layout>
  );
}

export const conversationReplyEmail = (props: ReplyProps & { subject: string }) => ({
  subject: /^re:/i.test(props.subject) ? props.subject : `Re: ${props.subject}`,
  body: <ConversationReplyEmail {...props} />,
});
