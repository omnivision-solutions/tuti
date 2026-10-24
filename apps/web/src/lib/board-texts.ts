/** A board's words for posting when the team hasn't set its own (Boards → Edit). */
export const BOARD_TEXT_DEFAULTS = {
  postButton: "Give feedback",
  titlePlaceholder: "Short, descriptive title",
  detailsPlaceholder: "Any more details? Type / for lists, images and more",
};

export const BOARD_TEXT_LIMITS = { postButton: 30, titlePlaceholder: 80, detailsPlaceholder: 120 };

type BoardTexts = { postButton?: string | null; titlePlaceholder?: string | null; detailsPlaceholder?: string | null };

/** A board's words for posting, its own or the defaults. */
export function boardTexts(board: BoardTexts) {
  return {
    postButton: board.postButton ?? BOARD_TEXT_DEFAULTS.postButton,
    titlePlaceholder: board.titlePlaceholder ?? BOARD_TEXT_DEFAULTS.titlePlaceholder,
    detailsPlaceholder: board.detailsPlaceholder ?? BOARD_TEXT_DEFAULTS.detailsPlaceholder,
  };
}
