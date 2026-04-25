/**
 * Map TS `Key` strings (W3C UI Events `code` values) to GhosttyKey enum
 * integers. Hand-maintained; if a future Ghostty pin adds keys, extend
 * both the `Key` union and `keyToGhosttyId` table.
 *
 * W3C reference: https://www.w3.org/TR/uievents-code/
 */
import { GhosttyKeyValues as G } from "./generated";

export type Key =
  // Writing System Keys
  | "Unidentified"
  | "Backquote" | "Backslash" | "BracketLeft" | "BracketRight" | "Comma"
  | "Digit0" | "Digit1" | "Digit2" | "Digit3" | "Digit4"
  | "Digit5" | "Digit6" | "Digit7" | "Digit8" | "Digit9"
  | "Equal" | "IntlBackslash" | "IntlRo" | "IntlYen"
  | "KeyA" | "KeyB" | "KeyC" | "KeyD" | "KeyE" | "KeyF" | "KeyG"
  | "KeyH" | "KeyI" | "KeyJ" | "KeyK" | "KeyL" | "KeyM" | "KeyN"
  | "KeyO" | "KeyP" | "KeyQ" | "KeyR" | "KeyS" | "KeyT" | "KeyU"
  | "KeyV" | "KeyW" | "KeyX" | "KeyY" | "KeyZ"
  | "Minus" | "Period" | "Quote" | "Semicolon" | "Slash"
  // Functional
  | "AltLeft" | "AltRight" | "Backspace" | "CapsLock" | "ContextMenu"
  | "ControlLeft" | "ControlRight" | "Enter" | "MetaLeft" | "MetaRight"
  | "ShiftLeft" | "ShiftRight" | "Space" | "Tab" | "Convert"
  | "KanaMode" | "NonConvert"
  // Control Pad
  | "Delete" | "End" | "Help" | "Home" | "Insert" | "PageDown" | "PageUp"
  // Arrow Pad
  | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "ArrowUp"
  // Numpad
  | "NumLock"
  | "Numpad0" | "Numpad1" | "Numpad2" | "Numpad3" | "Numpad4"
  | "Numpad5" | "Numpad6" | "Numpad7" | "Numpad8" | "Numpad9"
  | "NumpadAdd" | "NumpadBackspace" | "NumpadClear" | "NumpadClearEntry"
  | "NumpadComma" | "NumpadDecimal" | "NumpadDivide" | "NumpadEnter"
  | "NumpadEqual" | "NumpadMemoryAdd" | "NumpadMemoryClear"
  | "NumpadMemoryRecall" | "NumpadMemoryStore" | "NumpadMemorySubtract"
  | "NumpadMultiply" | "NumpadParenLeft" | "NumpadParenRight"
  | "NumpadSubtract" | "NumpadSeparator"
  | "NumpadUp" | "NumpadDown" | "NumpadRight" | "NumpadLeft"
  | "NumpadBegin" | "NumpadHome" | "NumpadEnd" | "NumpadInsert"
  | "NumpadDelete" | "NumpadPageUp" | "NumpadPageDown"
  // Function
  | "Escape"
  | "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7" | "F8"
  | "F9" | "F10" | "F11" | "F12" | "F13" | "F14" | "F15" | "F16"
  | "F17" | "F18" | "F19" | "F20" | "F21" | "F22" | "F23" | "F24" | "F25"
  | "Fn" | "FnLock" | "PrintScreen" | "ScrollLock" | "Pause"
  // Media
  | "BrowserBack" | "BrowserFavorites" | "BrowserForward" | "BrowserHome"
  | "BrowserRefresh" | "BrowserSearch" | "BrowserStop"
  | "Eject" | "LaunchApp1" | "LaunchApp2" | "LaunchMail"
  | "MediaPlayPause" | "MediaSelect" | "MediaStop"
  | "MediaTrackNext" | "MediaTrackPrevious"
  | "Power" | "Sleep"
  | "AudioVolumeDown" | "AudioVolumeMute" | "AudioVolumeUp"
  | "WakeUp"
  // Legacy / Special
  | "Copy" | "Cut" | "Paste";

export const keyToGhosttyId: Record<Key, number> = {
  Unidentified: G.GHOSTTY_KEY_UNIDENTIFIED,
  Backquote:    G.GHOSTTY_KEY_BACKQUOTE,
  Backslash:    G.GHOSTTY_KEY_BACKSLASH,
  BracketLeft:  G.GHOSTTY_KEY_BRACKET_LEFT,
  BracketRight: G.GHOSTTY_KEY_BRACKET_RIGHT,
  Comma:        G.GHOSTTY_KEY_COMMA,
  Digit0:       G.GHOSTTY_KEY_DIGIT_0,
  Digit1:       G.GHOSTTY_KEY_DIGIT_1,
  Digit2:       G.GHOSTTY_KEY_DIGIT_2,
  Digit3:       G.GHOSTTY_KEY_DIGIT_3,
  Digit4:       G.GHOSTTY_KEY_DIGIT_4,
  Digit5:       G.GHOSTTY_KEY_DIGIT_5,
  Digit6:       G.GHOSTTY_KEY_DIGIT_6,
  Digit7:       G.GHOSTTY_KEY_DIGIT_7,
  Digit8:       G.GHOSTTY_KEY_DIGIT_8,
  Digit9:       G.GHOSTTY_KEY_DIGIT_9,
  Equal:        G.GHOSTTY_KEY_EQUAL,
  IntlBackslash: G.GHOSTTY_KEY_INTL_BACKSLASH,
  IntlRo:       G.GHOSTTY_KEY_INTL_RO,
  IntlYen:      G.GHOSTTY_KEY_INTL_YEN,
  KeyA: G.GHOSTTY_KEY_A, KeyB: G.GHOSTTY_KEY_B, KeyC: G.GHOSTTY_KEY_C,
  KeyD: G.GHOSTTY_KEY_D, KeyE: G.GHOSTTY_KEY_E, KeyF: G.GHOSTTY_KEY_F,
  KeyG: G.GHOSTTY_KEY_G, KeyH: G.GHOSTTY_KEY_H, KeyI: G.GHOSTTY_KEY_I,
  KeyJ: G.GHOSTTY_KEY_J, KeyK: G.GHOSTTY_KEY_K, KeyL: G.GHOSTTY_KEY_L,
  KeyM: G.GHOSTTY_KEY_M, KeyN: G.GHOSTTY_KEY_N, KeyO: G.GHOSTTY_KEY_O,
  KeyP: G.GHOSTTY_KEY_P, KeyQ: G.GHOSTTY_KEY_Q, KeyR: G.GHOSTTY_KEY_R,
  KeyS: G.GHOSTTY_KEY_S, KeyT: G.GHOSTTY_KEY_T, KeyU: G.GHOSTTY_KEY_U,
  KeyV: G.GHOSTTY_KEY_V, KeyW: G.GHOSTTY_KEY_W, KeyX: G.GHOSTTY_KEY_X,
  KeyY: G.GHOSTTY_KEY_Y, KeyZ: G.GHOSTTY_KEY_Z,
  Minus:     G.GHOSTTY_KEY_MINUS,
  Period:    G.GHOSTTY_KEY_PERIOD,
  Quote:     G.GHOSTTY_KEY_QUOTE,
  Semicolon: G.GHOSTTY_KEY_SEMICOLON,
  Slash:     G.GHOSTTY_KEY_SLASH,
  AltLeft:      G.GHOSTTY_KEY_ALT_LEFT,
  AltRight:     G.GHOSTTY_KEY_ALT_RIGHT,
  Backspace:    G.GHOSTTY_KEY_BACKSPACE,
  CapsLock:     G.GHOSTTY_KEY_CAPS_LOCK,
  ContextMenu:  G.GHOSTTY_KEY_CONTEXT_MENU,
  ControlLeft:  G.GHOSTTY_KEY_CONTROL_LEFT,
  ControlRight: G.GHOSTTY_KEY_CONTROL_RIGHT,
  Enter:        G.GHOSTTY_KEY_ENTER,
  MetaLeft:     G.GHOSTTY_KEY_META_LEFT,
  MetaRight:    G.GHOSTTY_KEY_META_RIGHT,
  ShiftLeft:    G.GHOSTTY_KEY_SHIFT_LEFT,
  ShiftRight:   G.GHOSTTY_KEY_SHIFT_RIGHT,
  Space:        G.GHOSTTY_KEY_SPACE,
  Tab:          G.GHOSTTY_KEY_TAB,
  Convert:      G.GHOSTTY_KEY_CONVERT,
  KanaMode:     G.GHOSTTY_KEY_KANA_MODE,
  NonConvert:   G.GHOSTTY_KEY_NON_CONVERT,
  Delete:   G.GHOSTTY_KEY_DELETE,
  End:      G.GHOSTTY_KEY_END,
  Help:     G.GHOSTTY_KEY_HELP,
  Home:     G.GHOSTTY_KEY_HOME,
  Insert:   G.GHOSTTY_KEY_INSERT,
  PageDown: G.GHOSTTY_KEY_PAGE_DOWN,
  PageUp:   G.GHOSTTY_KEY_PAGE_UP,
  ArrowDown:  G.GHOSTTY_KEY_ARROW_DOWN,
  ArrowLeft:  G.GHOSTTY_KEY_ARROW_LEFT,
  ArrowRight: G.GHOSTTY_KEY_ARROW_RIGHT,
  ArrowUp:    G.GHOSTTY_KEY_ARROW_UP,
  NumLock:    G.GHOSTTY_KEY_NUM_LOCK,
  Numpad0: G.GHOSTTY_KEY_NUMPAD_0, Numpad1: G.GHOSTTY_KEY_NUMPAD_1,
  Numpad2: G.GHOSTTY_KEY_NUMPAD_2, Numpad3: G.GHOSTTY_KEY_NUMPAD_3,
  Numpad4: G.GHOSTTY_KEY_NUMPAD_4, Numpad5: G.GHOSTTY_KEY_NUMPAD_5,
  Numpad6: G.GHOSTTY_KEY_NUMPAD_6, Numpad7: G.GHOSTTY_KEY_NUMPAD_7,
  Numpad8: G.GHOSTTY_KEY_NUMPAD_8, Numpad9: G.GHOSTTY_KEY_NUMPAD_9,
  NumpadAdd:           G.GHOSTTY_KEY_NUMPAD_ADD,
  NumpadBackspace:     G.GHOSTTY_KEY_NUMPAD_BACKSPACE,
  NumpadClear:         G.GHOSTTY_KEY_NUMPAD_CLEAR,
  NumpadClearEntry:    G.GHOSTTY_KEY_NUMPAD_CLEAR_ENTRY,
  NumpadComma:         G.GHOSTTY_KEY_NUMPAD_COMMA,
  NumpadDecimal:       G.GHOSTTY_KEY_NUMPAD_DECIMAL,
  NumpadDivide:        G.GHOSTTY_KEY_NUMPAD_DIVIDE,
  NumpadEnter:         G.GHOSTTY_KEY_NUMPAD_ENTER,
  NumpadEqual:         G.GHOSTTY_KEY_NUMPAD_EQUAL,
  NumpadMemoryAdd:      G.GHOSTTY_KEY_NUMPAD_MEMORY_ADD,
  NumpadMemoryClear:    G.GHOSTTY_KEY_NUMPAD_MEMORY_CLEAR,
  NumpadMemoryRecall:   G.GHOSTTY_KEY_NUMPAD_MEMORY_RECALL,
  NumpadMemoryStore:    G.GHOSTTY_KEY_NUMPAD_MEMORY_STORE,
  NumpadMemorySubtract: G.GHOSTTY_KEY_NUMPAD_MEMORY_SUBTRACT,
  NumpadMultiply:       G.GHOSTTY_KEY_NUMPAD_MULTIPLY,
  NumpadParenLeft:      G.GHOSTTY_KEY_NUMPAD_PAREN_LEFT,
  NumpadParenRight:     G.GHOSTTY_KEY_NUMPAD_PAREN_RIGHT,
  NumpadSubtract:       G.GHOSTTY_KEY_NUMPAD_SUBTRACT,
  NumpadSeparator:      G.GHOSTTY_KEY_NUMPAD_SEPARATOR,
  NumpadUp:    G.GHOSTTY_KEY_NUMPAD_UP,
  NumpadDown:  G.GHOSTTY_KEY_NUMPAD_DOWN,
  NumpadRight: G.GHOSTTY_KEY_NUMPAD_RIGHT,
  NumpadLeft:  G.GHOSTTY_KEY_NUMPAD_LEFT,
  NumpadBegin: G.GHOSTTY_KEY_NUMPAD_BEGIN,
  NumpadHome:  G.GHOSTTY_KEY_NUMPAD_HOME,
  NumpadEnd:   G.GHOSTTY_KEY_NUMPAD_END,
  NumpadInsert:   G.GHOSTTY_KEY_NUMPAD_INSERT,
  NumpadDelete:   G.GHOSTTY_KEY_NUMPAD_DELETE,
  NumpadPageUp:   G.GHOSTTY_KEY_NUMPAD_PAGE_UP,
  NumpadPageDown: G.GHOSTTY_KEY_NUMPAD_PAGE_DOWN,
  Escape: G.GHOSTTY_KEY_ESCAPE,
  F1:  G.GHOSTTY_KEY_F1,  F2:  G.GHOSTTY_KEY_F2,  F3:  G.GHOSTTY_KEY_F3,
  F4:  G.GHOSTTY_KEY_F4,  F5:  G.GHOSTTY_KEY_F5,  F6:  G.GHOSTTY_KEY_F6,
  F7:  G.GHOSTTY_KEY_F7,  F8:  G.GHOSTTY_KEY_F8,  F9:  G.GHOSTTY_KEY_F9,
  F10: G.GHOSTTY_KEY_F10, F11: G.GHOSTTY_KEY_F11, F12: G.GHOSTTY_KEY_F12,
  F13: G.GHOSTTY_KEY_F13, F14: G.GHOSTTY_KEY_F14, F15: G.GHOSTTY_KEY_F15,
  F16: G.GHOSTTY_KEY_F16, F17: G.GHOSTTY_KEY_F17, F18: G.GHOSTTY_KEY_F18,
  F19: G.GHOSTTY_KEY_F19, F20: G.GHOSTTY_KEY_F20, F21: G.GHOSTTY_KEY_F21,
  F22: G.GHOSTTY_KEY_F22, F23: G.GHOSTTY_KEY_F23, F24: G.GHOSTTY_KEY_F24,
  F25: G.GHOSTTY_KEY_F25,
  Fn:          G.GHOSTTY_KEY_FN,
  FnLock:      G.GHOSTTY_KEY_FN_LOCK,
  PrintScreen: G.GHOSTTY_KEY_PRINT_SCREEN,
  ScrollLock:  G.GHOSTTY_KEY_SCROLL_LOCK,
  Pause:       G.GHOSTTY_KEY_PAUSE,
  BrowserBack:      G.GHOSTTY_KEY_BROWSER_BACK,
  BrowserFavorites: G.GHOSTTY_KEY_BROWSER_FAVORITES,
  BrowserForward:   G.GHOSTTY_KEY_BROWSER_FORWARD,
  BrowserHome:      G.GHOSTTY_KEY_BROWSER_HOME,
  BrowserRefresh:   G.GHOSTTY_KEY_BROWSER_REFRESH,
  BrowserSearch:    G.GHOSTTY_KEY_BROWSER_SEARCH,
  BrowserStop:      G.GHOSTTY_KEY_BROWSER_STOP,
  Eject:        G.GHOSTTY_KEY_EJECT,
  LaunchApp1:   G.GHOSTTY_KEY_LAUNCH_APP_1,
  LaunchApp2:   G.GHOSTTY_KEY_LAUNCH_APP_2,
  LaunchMail:   G.GHOSTTY_KEY_LAUNCH_MAIL,
  MediaPlayPause:    G.GHOSTTY_KEY_MEDIA_PLAY_PAUSE,
  MediaSelect:       G.GHOSTTY_KEY_MEDIA_SELECT,
  MediaStop:         G.GHOSTTY_KEY_MEDIA_STOP,
  MediaTrackNext:    G.GHOSTTY_KEY_MEDIA_TRACK_NEXT,
  MediaTrackPrevious: G.GHOSTTY_KEY_MEDIA_TRACK_PREVIOUS,
  Power:        G.GHOSTTY_KEY_POWER,
  Sleep:        G.GHOSTTY_KEY_SLEEP,
  AudioVolumeDown: G.GHOSTTY_KEY_AUDIO_VOLUME_DOWN,
  AudioVolumeMute: G.GHOSTTY_KEY_AUDIO_VOLUME_MUTE,
  AudioVolumeUp:   G.GHOSTTY_KEY_AUDIO_VOLUME_UP,
  WakeUp:       G.GHOSTTY_KEY_WAKE_UP,
  Copy:  G.GHOSTTY_KEY_COPY,
  Cut:   G.GHOSTTY_KEY_CUT,
  Paste: G.GHOSTTY_KEY_PASTE,
};
