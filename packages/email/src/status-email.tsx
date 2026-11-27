import { Button } from "@react-email/components";

import { inTheirWords, Message, Paragraph, peopleLanguage, PostCard } from "./blocks";
import { emailTranslator } from "./language";
import { buttonStyle, type EmailBrand, Eyebrow, FooterLink, Layout, Title } from "./layout";

/** The statuses a post's people hear about before it ships (Completed's is the shipped email), each as it reads. */
const STATUSES = {
  PLANNED: { is: "isPlanned", next: "plannedNext" },
  IN_PROGRESS: { is: "isInProgress", next: "inProgressNext" },
} as const;

export type ProgressStatus = keyof typeof STATUSES;

/**
 * `note`: the team's comment posted with the change, quoted under the news. `board`: left out for a Team only board's.
 * `language`: the reader's (readerEmailLanguage), else English; `teamLanguage`: the project's default, the board's name's.
 */
type StatusProps = EmailBrand & {
  status: ProgressStatus;
  postTitle: string;
  board?: string;
  votes: number;
  postUrl: string;
  unsubscribeUrl: string;
  note?: { from: string; text: string };
  language?: string;
  teamLanguage?: string;
};

export function StatusEmail({ projectName, accent, poweredBy, logo, logoText, status, postTitle, board, votes, postUrl, unsubscribeUrl, note, language, teamLanguage }: StatusProps) {
  const t = emailTranslator(language, "emails");
  const { is, next } = STATUSES[status];
  const words = peopleLanguage(language, teamLanguage);
  return (
    <Layout
      preview={t("statusPreview", { status: emailTranslator(language, "feedback")(`status.${status}`) })}
      project={{ projectName, accent, poweredBy, logo, logoText }}
      footer={t.rich("followFooter", { name: projectName, link: (chunks) => <FooterLink href={unsubscribeUrl}>{chunks}</FooterLink> })}
      language={language}
    >
      <Eyebrow accent={accent}>{t("statusEyebrow")}</Eyebrow>
      <Title>{t.rich(is, { title: inTheirWords(postTitle, words) })}</Title>
      <PostCard title={postTitle} votes={votes} board={board} status={status} language={language} teamLanguage={teamLanguage} />
      <Paragraph>{t(next)}</Paragraph>
      {note && (
        <Message name={note.from} team={t("teamOf", { name: projectName })} accent={accent} lang={words}>
          {note.text}
        </Message>
      )}
      <Button href={postUrl} style={buttonStyle(accent)}>
        {t("seeIdea")}
      </Button>
    </Layout>
  );
}

export const statusEmail = (props: StatusProps) => ({
  subject: emailTranslator(props.language, "emails")("statusSubject", {
    status: emailTranslator(props.language, "feedback")(`status.${props.status}`),
    title: props.postTitle,
  }),
  body: <StatusEmail {...props} />,
});
