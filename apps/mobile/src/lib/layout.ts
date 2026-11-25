import { useWindowDimensions } from "react-native";

/**
 * From this big (the window's width and height in points, never the kind of device), the Inbox and the conversation sit
 * side by side, as on the web: a tablet either way round, a foldable opened, an iPad's app in a wide split. The window's
 * size, so a foldable folded or a split narrowed switches back live. Its height too: a phone turned sideways is wide but
 * short, and keeps one pane (two would leave the messages a sliver above the keyboard).
 */
export const WIDE = 600;

export const useWide = () => {
  const { width, height } = useWindowDimensions();
  return Math.min(width, height) >= WIDE;
};

/** The list's column, beside the conversation: about two fifths of the window, between a phone's width and a little more. */
export const listWidth = (width: number) => Math.round(Math.min(400, Math.max(320, width * 0.38)));

/**
 * The conversation chosen beside the Inbox's list, forgotten: when a conversation is opened on its own (a narrow window)
 * or something is about to open one (a notification's tap), so a choice left over from a wide window, of whatever
 * project, is never pushed later. The Inbox listens.
 */
const forgetting = new Set<() => void>();
export function onForgetChosen(listener: () => void) {
  forgetting.add(listener);
  return () => void forgetting.delete(listener);
}
export const forgetChosen = () => forgetting.forEach((listener) => listener());
