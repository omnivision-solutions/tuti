-- Autopilot's Undo: an applied update put back. It stays, so it isn't proposed again.
ALTER TYPE "CodeChangeActionStatus" ADD VALUE 'UNDONE';
