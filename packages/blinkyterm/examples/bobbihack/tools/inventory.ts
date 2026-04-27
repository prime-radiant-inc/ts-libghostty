// inventory({}) — free-action read of the player's carry. Sends 'i' to
// open the inventory display, parses the screen, dismisses with space,
// and awaits the post-dismiss frame so the GameMap returns to play state.

import type { ToolContext } from "../tool-context";

export interface InventoryItem {
  slot: string;
  description: string;
  category: string;
}

export interface ParsedInventory {
  items: InventoryItem[];
  hasMorePages: boolean;
}

// NetHack 3.6 inventory is rendered as an *overlay* — items typically
// appear on the right side of the screen with the underlying dungeon map
// still visible on the left. Item lines look like:
//
//     "           |......f...|        b - a +0 dagger (alternate weapon)"
//
// So we can't anchor at start-of-line. We look for the canonical
// "<letter> - <description>" pattern anywhere on the line, but only
// after at least 2 spaces (to avoid catching map glyphs like ".-." that
// happen to contain hyphens).
const ITEM_LINE_RE = /(?:^|\s{2,})([a-zA-Z\$#?\*\-])\s+-\s+(.+?)\s*$/;
const PAGE_END_RE = /\(end\)/;
const PAGE_OF_RE = /\((\d+)\s+of\s+(\d+)\)/;
// Category headers in NetHack 3.6: a single capitalized word/phrase
// (Weapons, Armor, Comestibles, Tools, Scrolls, Potions, ...) typically
// rendered with an inverted style. After ANSI stripping (snapshot.text)
// it's just whitespace + the word.
const CATEGORY_RE = /(?:^|\s{2,})([A-Z][A-Za-z]+)\s*$/;
// Known NetHack inventory category names — match against these to be
// sure we're not picking up a stray capitalized word.
const KNOWN_CATEGORIES = new Set([
  "Weapons",
  "Armor",
  "Comestibles",
  "Tools",
  "Scrolls",
  "Potions",
  "Wands",
  "Rings",
  "Amulets",
  "Spellbooks",
  "Gems",
  "Coins",
  "Boulders",
  "Iron",
  "Chains",
  "Venom",
]);

export function parseInventoryScreen(rows: string[]): ParsedInventory {
  const items: InventoryItem[] = [];
  let category = "";
  let hasMorePages = false;
  for (const raw of rows) {
    const line = raw.trimEnd();
    if (line.length === 0) continue;
    if (PAGE_END_RE.test(line)) {
      hasMorePages = false;
      break;
    }
    const pageMatch = line.match(PAGE_OF_RE);
    if (pageMatch) {
      const cur = parseInt(pageMatch[1] ?? "1", 10);
      const total = parseInt(pageMatch[2] ?? "1", 10);
      hasMorePages = cur < total;
      break;
    }
    const itemMatch = line.match(ITEM_LINE_RE);
    if (itemMatch) {
      items.push({
        slot: itemMatch[1] ?? "",
        description: itemMatch[2] ?? "",
        category,
      });
      continue;
    }
    const catMatch = line.match(CATEGORY_RE);
    if (catMatch && KNOWN_CATEGORIES.has(catMatch[1] ?? "")) {
      category = catMatch[1] ?? "";
    }
    // Anything else (map rows, separators, "Not carrying anything.") is ignored.
  }
  return { items, hasMorePages };
}

const MAX_PAGES = 6;

export async function handleInventory(
  _args: object,
  ctx: ToolContext,
): Promise<string> {
  // Open the inventory view.
  let result = await ctx.sendKeysAndWait("i");
  let allItems: InventoryItem[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const parsed = parseInventoryScreen(result.rows);
    allItems = allItems.concat(parsed.items);
    if (!parsed.hasMorePages) break;
    // Advance to the next page.
    result = await ctx.sendKeysAndWait(" ");
  }
  // Dismiss the final page (which has "(end)" or the last "(N of M)").
  // After (end), a space dismisses cleanly. After the final page-of, we
  // still need to dismiss.
  result = await ctx.sendKeysAndWait(" ");
  // Return as JSON tool_result content. The non-screen tool result shape.
  return JSON.stringify({
    items: allItems,
    note: result.message ? `dismissed; message: ${result.message}` : "dismissed",
  });
}
