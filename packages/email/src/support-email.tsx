import { Button, Link, Text } from "@react-email/components";

import { colors, Layout } from "./layout";

const body = { fontSize: 15, color: colors.text, lineHeight: "24px" };
const label = { fontSize: 13, color: colors.muted, lineHeight: "20px", margin: "16px 0 0" };
const value = { ...body, margin: "4px 0 0", whiteSpace: "pre-line" as const };

type ConfirmProps = { projectName: string; url: string };

/** Asks a project's new support address to confirm it ("Ask a person" sends questions there once it does). */
export function SupportEmailConfirmEmail({ projectName, url }: ConfirmProps) {
  return (
    <Layout preview={`Confirm this address for ${projectName}'s docs.`}>
      <Text style={body}>
        Someone on the <strong>{projectName}</strong> team set this address to get questions from its docs that the AI
        couldn&apos;t answer. Replies go straight to the person who asked.
      </Text>
      <Button
        href={url}
        style={{ backgroundColor: colors.green, color: "#ffffff", borderRadius: 10, padding: "12px 20px", fontSize: 15, fontWeight: 600 }}
      >
        Confirm this address
      </Button>
      <Text style={{ fontSize: 13, color: colors.muted, lineHeight: "20px", marginTop: 24 }}>
        Nothing is sent here until it&apos;s confirmed. If you didn&apos;t expect this, ignore it.
      </Text>
    </Layout>
  );
}

export const supportEmailConfirmEmail = (props: ConfirmProps) => ({
  subject: `Confirm the support email for ${props.projectName}`,
  body: <SupportEmailConfirmEmail {...props} />,
});

type EscalationProps = {
  projectName: string;
  /** The visitor's address (replies go there). */
  from: string;
  question: string;
  note: string | null;
  /** The AI's answer, if it gave one. */
  answer: string | null;
  /** Whether the visitor gave the answer a thumbs-down. */
  notHelpful: boolean;
  /** The articles the answer cites; `url` is null for an AI-only article. */
  sources: { title: string; url: string | null }[];
  /** A short AI summary of what the visitor needs; null if it couldn't be written. */
  summary: string | null;
  /** The visitor's copy, rather than the team's. */
  copy?: boolean;
};

/** A question the AI couldn't help with, passed to the team ("Ask a person"); the visitor gets a copy. All of it is plain text. */
export function EscalationEmail({ projectName, from, question, note, answer, notHelpful, sources, summary, copy = false }: EscalationProps) {
  return (
    <Layout preview={copy ? `We've passed your question to the ${projectName} team.` : `${from} asked: ${question}`}>
      <Text style={body}>
        {copy ? (
          <>
            We&apos;ve passed your question to the <strong>{projectName}</strong> team; they&apos;ll reply by email. This is what
            we sent them.
          </>
        ) : (
          <>
            <strong>{from}</strong> asked for help in <strong>{projectName}</strong>&apos;s docs. Reply to this email to
            answer them.
          </>
        )}
      </Text>
      {summary && (
        <>
          <Text style={label}>Summary (written by AI)</Text>
          <Text style={value}>{summary}</Text>
        </>
      )}
      <Text style={label}>Question</Text>
      <Text style={value}>{question}</Text>
      {note && (
        <>
          <Text style={label}>Note</Text>
          <Text style={value}>{note}</Text>
        </>
      )}
      <Text style={label}>{answer ? `The AI's answer${notHelpful ? " (marked not helpful)" : ""}` : "The AI's answer"}</Text>
      <Text style={value}>{answer ?? "None: it couldn't answer."}</Text>
      {sources.length > 0 && (
        <>
          <Text style={label}>Articles it cited</Text>
          {sources.map((source, i) => (
            <Text key={i} style={{ ...body, margin: "4px 0 0" }}>
              {source.url ? <Link href={source.url}>{source.title}</Link> : source.title}
            </Text>
          ))}
        </>
      )}
    </Layout>
  );
}

/** One line: the question, cut to fit a subject. */
const subjectLine = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

export const escalationEmail = (props: EscalationProps) => ({
  subject: props.copy ? `Your question to ${props.projectName}` : `Question from the docs: ${subjectLine(props.question)}`,
  body: <EscalationEmail {...props} />,
});
