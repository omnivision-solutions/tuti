-- The widget's Messages with the AI in the conversation (docs/plan.md, Inbox automation, W13): the AI's answer's question
-- and sources on its message, for the thread's sources and thumbs.
ALTER TABLE "conversation_message" ADD COLUMN "aiAnswer" JSONB;
