-- Out of AI credits: an AI answer that wasn't asked, and a code change that waits to be resumed.
ALTER TYPE "DocsNoAnswerCause" ADD VALUE 'NO_CREDITS';
ALTER TYPE "CodeChangeState" ADD VALUE 'PAUSED';
