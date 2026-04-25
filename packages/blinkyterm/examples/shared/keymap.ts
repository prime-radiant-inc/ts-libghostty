export type BotMove =
  | "north"
  | "south"
  | "east"
  | "west"
  | "search"
  | "pickup";

/**
 * Maps the example bot's abstract move vocabulary to NetHack's vi-style
 * keybindings. `search` is `s` (rest/search a turn) and `pickup` is `,`.
 */
export function toKeystroke(move: BotMove): string {
  switch (move) {
    case "north":
      return "k";
    case "south":
      return "j";
    case "east":
      return "l";
    case "west":
      return "h";
    case "search":
      return "s";
    case "pickup":
      return ",";
  }
}
