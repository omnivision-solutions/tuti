import { Button } from "@react-email/components";

import { inTheirWords, Message, Paragraph, peopleLanguage, PostCard, type PostStatus } from "./blocks";
import { emailTranslator } from "./language";
import { buttonStyle, type EmailBrand, Eyebrow, FooterLink, Layout, Title } from "./layout";

/**
 * `note`: the team's comment posted with the completion, quoted under the news. `language`: the reader's
 * (readerEmailLanguage), else English; `teamLanguage`: the project's default, the board's name's.
 */
type ShippedProps = EmailBrand & {
  postTitle: string;
  /** The post's votes, board and status, shown in its card. */
  votes?: number;
  board?: string;
  status?: PostStatus;
  postUrl: string;
  unsubscribeUrl: string;
  note?: { from: string; text: string };
  language?: string;
  teamLanguage?: string;
};

export function ShippedEmail({ projectName, postTitle, votes, board, status = "COMPLETED", postUrl, unsubscribeUrl, note, accent, poweredBy, logo, logoText, language, teamLanguage }: ShippedProps) {
  const t = emailTranslator(language, "emails");
  const words = peopleLanguage(language, teamLanguage);
  return (
    <Layout
      preview={t("shippedPreview", { title: postTitle })}
      project={{ projectName, accent, poweredBy, logo, logoText }}
      footer={t.rich("followFooter", { name: projectName, link: (chunks) => <FooterLink href={unsubscribeUrl}>{chunks}</FooterLink> })}
      language={language}
    >
      <Eyebrow accent={accent}>{t("shippedEyebrow")}</Eyebrow>
      <Title>{t.rich("shippedTitle", { title: inTheirWords(postTitle, words) })}</Title>
      <Paragraph>{t("goodNews", { name: projectName })}</Paragraph>
      <PostCard title={postTitle} votes={votes} board={board} status={status} language={language} teamLanguage={teamLanguage} />
      {note && (
        <Message name={note.from} team={t("teamOf", { name: projectName })} accent={accent} lang={words}>
          {note.text}
        </Message>
      )}
      <Button
        href={postUrl}
        style={buttonStyle(accent)}
      >
        {t("seePost")}
      </Button>
    </Layout>
  );
}

export const shippedEmail = (props: ShippedProps) => ({
  subject: emailTranslator(props.language, "emails")("shippedSubject", { title: props.postTitle }),
  body: <ShippedEmail {...props} />,
});
