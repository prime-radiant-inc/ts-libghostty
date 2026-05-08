// v2 cell classifier for the bobbihack autopilot.
//
// Produces a `(terrain, foreground)` tuple per FrameSnapshot cell, exposing
// the letter / pet / color information the v1 `classifyGlyph` +
// `glyph-class.ts:classifyCell` pair collapsed away.
//
// This module is the new shape; the v1 modules stay in place during the
// Phase 1 refactor and the cutover happens in Phase 2.
//
// Source of truth for the MonsterClass enumeration: NetHack 5.0
// `include/defsym.h` MONSYM macro (60 entries, IDs 1..60). We split
// `INVISIBLE` (`I`, ID 35) out of the class union — it surfaces as
// `foreground.kind === 'unseen-monster'` instead, since its semantics
// (a placeholder for a creature we cannot classify) are categorically
// different.

// 58 monster classes. Mirrors MONSYM minus INVISIBLE — see header comment.
// `ghost` corresponds to the ` ` (space) char, which we do not treat as a
// classifiable cell (most blank cells are unknown terrain). The class name
// stays in the union for completeness; LETTER_TO_CLASS does not produce it.
export type MonsterClass =
  | "ant"
  | "blob"
  | "cockatrice"
  | "dog"
  | "eye"
  | "feline"
  | "gremlin"
  | "humanoid"
  | "imp"
  | "jelly"
  | "kobold"
  | "leprechaun"
  | "mimic"
  | "nymph"
  | "orc"
  | "piercer"
  | "quadruped"
  | "rodent"
  | "spider"
  | "trapper"
  | "unicorn"
  | "vortex"
  | "worm"
  | "xan"
  | "light"
  | "zruty"
  | "angel"
  | "bat"
  | "centaur"
  | "dragon"
  | "elemental"
  | "fungus"
  | "gnome"
  | "giant"
  | "jabberwock"
  | "kop"
  | "lich"
  | "mummy"
  | "naga"
  | "ogre"
  | "pudding"
  | "quantmech"
  | "rustmonst"
  | "snake"
  | "troll"
  | "umber"
  | "vampire"
  | "wraith"
  | "xorn"
  | "yeti"
  | "zombie"
  | "human"
  | "ghost"
  | "golem"
  | "demon"
  | "eel"
  | "lizard"
  | "worm-tail"
  | "mimic-def";

// Mapping from glyph char → MonsterClass. 58 entries:
//   26 lowercase letters (a..z)
//   25 uppercase letters (A..Z minus 'I', which is unseen-monster)
//   7 specials: '@', "'", '&', ';', ':', '~', ']'
//
// Per MONSYM in NetHack-5.0/include/defsym.h. The space-ghost MONSYM(54)
// is intentionally absent from this table — see header comment.
export const LETTER_TO_CLASS: Readonly<Record<string, MonsterClass>> = {
  a: "ant",
  b: "blob",
  c: "cockatrice",
  d: "dog",
  e: "eye",
  f: "feline",
  g: "gremlin",
  h: "humanoid",
  i: "imp",
  j: "jelly",
  k: "kobold",
  l: "leprechaun",
  m: "mimic",
  n: "nymph",
  o: "orc",
  p: "piercer",
  q: "quadruped",
  r: "rodent",
  s: "spider",
  t: "trapper",
  u: "unicorn",
  v: "vortex",
  w: "worm",
  x: "xan",
  y: "light",
  z: "zruty",
  A: "angel",
  B: "bat",
  C: "centaur",
  D: "dragon",
  E: "elemental",
  F: "fungus",
  G: "gnome",
  H: "giant",
  // I = INVISIBLE → handled as foreground.kind === 'unseen-monster'.
  J: "jabberwock",
  K: "kop",
  L: "lich",
  M: "mummy",
  N: "naga",
  O: "ogre",
  P: "pudding",
  Q: "quantmech",
  R: "rustmonst",
  S: "snake",
  T: "troll",
  U: "umber",
  V: "vampire",
  W: "wraith",
  X: "xorn",
  Y: "yeti",
  Z: "zombie",
  "@": "human",
  "'": "golem",
  "&": "demon",
  ";": "eel",
  ":": "lizard",
  "~": "worm-tail",
  "]": "mimic-def",
};
