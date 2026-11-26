/** A board's words for posting when the team hasn't set its own (Boards → Edit). */
export const BOARD_TEXT_DEFAULTS = {
  postButton: "Submit post",
  titlePlaceholder: "Short, descriptive title",
  detailsPlaceholder: "Any more details? Type / for lists, images and more",
};

export const BOARD_TEXT_LIMITS = { postButton: 30, titlePlaceholder: 80, detailsPlaceholder: 120 };

type BoardTexts = { postButton?: string | null; titlePlaceholder?: string | null; detailsPlaceholder?: string | null };

/** A board's words for posting, its own or the defaults (`defaults`: in the portal page's language). */
export function boardTexts(board: BoardTexts, defaults: typeof BOARD_TEXT_DEFAULTS = BOARD_TEXT_DEFAULTS) {
  return {
    postButton: board.postButton ?? defaults.postButton,
    titlePlaceholder: board.titlePlaceholder ?? defaults.titlePlaceholder,
    detailsPlaceholder: board.detailsPlaceholder ?? defaults.detailsPlaceholder,
  };
}
