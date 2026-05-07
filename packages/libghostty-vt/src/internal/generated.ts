// GENERATED FILE — do not edit by hand.
// Regenerate with `bun run build:native`.
// Pinned Ghostty commit: e88c6c099152dd6d2d7e517516e1f3c183c152f7

export const pinnedCommit = "e88c6c099152dd6d2d7e517516e1f3c183c152f7" as const;

export const EXPECTED_LIBRARY_VERSION = "0.1.0-dev" as const;

// DIAGNOSTIC: every ghostty_* function declared in a pinned header.
// Used by ABI-smoke to assert requiredSymbols ⊆ declaredHeaderSymbols.
export const declaredHeaderSymbols = [
  "ghostty_alloc",
  "ghostty_build_info",
  "ghostty_cell_get",
  "ghostty_cell_get_multi",
  "ghostty_color_rgb_get",
  "ghostty_focus_encode",
  "ghostty_formatter_format_alloc",
  "ghostty_formatter_format_buf",
  "ghostty_formatter_free",
  "ghostty_formatter_terminal_new",
  "ghostty_free",
  "ghostty_grid_ref_cell",
  "ghostty_grid_ref_graphemes",
  "ghostty_grid_ref_hyperlink_uri",
  "ghostty_grid_ref_row",
  "ghostty_grid_ref_style",
  "ghostty_key_encoder_encode",
  "ghostty_key_encoder_free",
  "ghostty_key_encoder_new",
  "ghostty_key_encoder_setopt",
  "ghostty_key_encoder_setopt_from_terminal",
  "ghostty_key_event_free",
  "ghostty_key_event_get_action",
  "ghostty_key_event_get_composing",
  "ghostty_key_event_get_consumed_mods",
  "ghostty_key_event_get_key",
  "ghostty_key_event_get_mods",
  "ghostty_key_event_get_unshifted_codepoint",
  "ghostty_key_event_get_utf8",
  "ghostty_key_event_new",
  "ghostty_key_event_set_action",
  "ghostty_key_event_set_composing",
  "ghostty_key_event_set_consumed_mods",
  "ghostty_key_event_set_key",
  "ghostty_key_event_set_mods",
  "ghostty_key_event_set_unshifted_codepoint",
  "ghostty_key_event_set_utf8",
  "ghostty_kitty_graphics_get",
  "ghostty_kitty_graphics_image",
  "ghostty_kitty_graphics_image_get",
  "ghostty_kitty_graphics_image_get_multi",
  "ghostty_kitty_graphics_placement_get",
  "ghostty_kitty_graphics_placement_get_multi",
  "ghostty_kitty_graphics_placement_grid_size",
  "ghostty_kitty_graphics_placement_iterator_free",
  "ghostty_kitty_graphics_placement_iterator_new",
  "ghostty_kitty_graphics_placement_iterator_set",
  "ghostty_kitty_graphics_placement_next",
  "ghostty_kitty_graphics_placement_pixel_size",
  "ghostty_kitty_graphics_placement_rect",
  "ghostty_kitty_graphics_placement_render_info",
  "ghostty_kitty_graphics_placement_source_rect",
  "ghostty_kitty_graphics_placement_viewport_pos",
  "ghostty_mode_report_encode",
  "ghostty_mouse_encoder_encode",
  "ghostty_mouse_encoder_free",
  "ghostty_mouse_encoder_new",
  "ghostty_mouse_encoder_reset",
  "ghostty_mouse_encoder_setopt",
  "ghostty_mouse_encoder_setopt_from_terminal",
  "ghostty_mouse_event_clear_button",
  "ghostty_mouse_event_free",
  "ghostty_mouse_event_get_action",
  "ghostty_mouse_event_get_button",
  "ghostty_mouse_event_get_mods",
  "ghostty_mouse_event_get_position",
  "ghostty_mouse_event_new",
  "ghostty_mouse_event_set_action",
  "ghostty_mouse_event_set_button",
  "ghostty_mouse_event_set_mods",
  "ghostty_mouse_event_set_position",
  "ghostty_osc_command_data",
  "ghostty_osc_command_type",
  "ghostty_osc_end",
  "ghostty_osc_free",
  "ghostty_osc_new",
  "ghostty_osc_next",
  "ghostty_osc_reset",
  "ghostty_paste_encode",
  "ghostty_paste_is_safe",
  "ghostty_render_state_colors_get",
  "ghostty_render_state_free",
  "ghostty_render_state_get",
  "ghostty_render_state_get_multi",
  "ghostty_render_state_new",
  "ghostty_render_state_row_cells_free",
  "ghostty_render_state_row_cells_get",
  "ghostty_render_state_row_cells_get_multi",
  "ghostty_render_state_row_cells_new",
  "ghostty_render_state_row_cells_next",
  "ghostty_render_state_row_cells_select",
  "ghostty_render_state_row_get",
  "ghostty_render_state_row_get_multi",
  "ghostty_render_state_row_iterator_free",
  "ghostty_render_state_row_iterator_new",
  "ghostty_render_state_row_iterator_next",
  "ghostty_render_state_row_set",
  "ghostty_render_state_set",
  "ghostty_render_state_update",
  "ghostty_row_get",
  "ghostty_row_get_multi",
  "ghostty_sgr_attribute_tag",
  "ghostty_sgr_attribute_value",
  "ghostty_sgr_free",
  "ghostty_sgr_new",
  "ghostty_sgr_next",
  "ghostty_sgr_reset",
  "ghostty_sgr_set_params",
  "ghostty_sgr_unknown_full",
  "ghostty_sgr_unknown_partial",
  "ghostty_size_report_encode",
  "ghostty_style_default",
  "ghostty_style_is_default",
  "ghostty_sys_log_stderr",
  "ghostty_sys_set",
  "ghostty_terminal_free",
  "ghostty_terminal_get",
  "ghostty_terminal_get_multi",
  "ghostty_terminal_grid_ref",
  "ghostty_terminal_mode_get",
  "ghostty_terminal_mode_set",
  "ghostty_terminal_new",
  "ghostty_terminal_point_from_grid_ref",
  "ghostty_terminal_reset",
  "ghostty_terminal_resize",
  "ghostty_terminal_scroll_viewport",
  "ghostty_terminal_set",
  "ghostty_terminal_vt_write",
  "ghostty_type_json",
  "ghostty_wasm_alloc_opaque",
  "ghostty_wasm_alloc_sgr_attribute",
  "ghostty_wasm_alloc_u16_array",
  "ghostty_wasm_alloc_u8",
  "ghostty_wasm_alloc_u8_array",
  "ghostty_wasm_alloc_usize",
  "ghostty_wasm_free_opaque",
  "ghostty_wasm_free_sgr_attribute",
  "ghostty_wasm_free_u16_array",
  "ghostty_wasm_free_u8",
  "ghostty_wasm_free_u8_array",
  "ghostty_wasm_free_usize",
] as const;

export interface StructField { offset: number; size: number; kind: "uint" | "int" | "bool" | "ptr" | "struct"; }
export interface StructLayout { size: number; align: number; isSized: boolean; fields: Record<string, StructField>; }
export const structLayouts: Record<string, StructLayout> = {
  "GhosttyTerminalOptions": {
    size: 16, align: 8, isSized: false,
    fields: {
      "cols": { offset: 0, size: 2, kind: "uint" },
      "rows": { offset: 2, size: 2, kind: "uint" },
      "max_scrollback": { offset: 8, size: 8, kind: "uint" },
    },
  },
  "GhosttyFormatterTerminalOptions": {
    size: 56, align: 8, isSized: true,
    fields: {
      "size": { offset: 0, size: 8, kind: "uint" },
      "emit": { offset: 8, size: 4, kind: "uint" },
      "unwrap": { offset: 12, size: 1, kind: "bool" },
      "trim": { offset: 13, size: 1, kind: "bool" },
      "extra": { offset: 16, size: 32, kind: "struct" },
      "selection": { offset: 48, size: 8, kind: "ptr" },
    },
  },
  "GhosttyFormatterTerminalExtra": {
    size: 32, align: 8, isSized: true,
    fields: {
      "size": { offset: 0, size: 8, kind: "uint" },
      "palette": { offset: 8, size: 1, kind: "bool" },
      "modes": { offset: 9, size: 1, kind: "bool" },
      "scrolling_region": { offset: 10, size: 1, kind: "bool" },
      "tabstops": { offset: 11, size: 1, kind: "bool" },
      "pwd": { offset: 12, size: 1, kind: "bool" },
      "keyboard": { offset: 13, size: 1, kind: "bool" },
      "screen": { offset: 16, size: 16, kind: "struct" },
    },
  },
  "GhosttyFormatterScreenExtra": {
    size: 16, align: 8, isSized: true,
    fields: {
      "size": { offset: 0, size: 8, kind: "uint" },
      "cursor": { offset: 8, size: 1, kind: "bool" },
      "style": { offset: 9, size: 1, kind: "bool" },
      "hyperlink": { offset: 10, size: 1, kind: "bool" },
      "protection": { offset: 11, size: 1, kind: "bool" },
      "kitty_keyboard": { offset: 12, size: 1, kind: "bool" },
      "charsets": { offset: 13, size: 1, kind: "bool" },
    },
  },
  "GhosttyColorRgb": {
    size: 3, align: 1, isSized: false,
    fields: {
      "r": { offset: 0, size: 1, kind: "uint" },
      "g": { offset: 1, size: 1, kind: "uint" },
      "b": { offset: 2, size: 1, kind: "uint" },
    },
  },
  "GhosttyStyleColor": {
    size: 16, align: 8, isSized: false,
    fields: {
      "tag": { offset: 0, size: 4, kind: "int" },
      "value": { offset: 8, size: 8, kind: "struct" },
    },
  },
  "GhosttyStyle": {
    size: 72, align: 8, isSized: true,
    fields: {
      "size": { offset: 0, size: 8, kind: "uint" },
      "fg_color": { offset: 8, size: 16, kind: "struct" },
      "bg_color": { offset: 24, size: 16, kind: "struct" },
      "underline_color": { offset: 40, size: 16, kind: "struct" },
      "bold": { offset: 56, size: 1, kind: "bool" },
      "italic": { offset: 57, size: 1, kind: "bool" },
      "faint": { offset: 58, size: 1, kind: "bool" },
      "blink": { offset: 59, size: 1, kind: "bool" },
      "inverse": { offset: 60, size: 1, kind: "bool" },
      "invisible": { offset: 61, size: 1, kind: "bool" },
      "strikethrough": { offset: 62, size: 1, kind: "bool" },
      "overline": { offset: 63, size: 1, kind: "bool" },
      "underline": { offset: 64, size: 4, kind: "int" },
    },
  },
  "GhosttyRenderStateColors": {
    size: 792, align: 8, isSized: true,
    fields: {
      "size": { offset: 0, size: 8, kind: "uint" },
      "background": { offset: 8, size: 3, kind: "struct" },
      "foreground": { offset: 11, size: 3, kind: "struct" },
      "cursor": { offset: 14, size: 3, kind: "struct" },
      "cursor_has_value": { offset: 17, size: 1, kind: "bool" },
      "palette": { offset: 18, size: 768, kind: "struct" },
    },
  },
  "GhosttyGridRef": {
    size: 24, align: 8, isSized: true,
    fields: {
      "size": { offset: 0, size: 8, kind: "uint" },
      "node": { offset: 8, size: 8, kind: "ptr" },
      "x": { offset: 16, size: 2, kind: "uint" },
      "y": { offset: 18, size: 2, kind: "uint" },
    },
  },
  "GhosttyPointCoordinate": {
    size: 8, align: 4, isSized: false,
    fields: {
      "x": { offset: 0, size: 2, kind: "uint" },
      "y": { offset: 4, size: 4, kind: "uint" },
    },
  },
  "GhosttyPoint": {
    size: 24, align: 8, isSized: false,
    fields: {
      "tag": { offset: 0, size: 4, kind: "int" },
      "value": { offset: 8, size: 16, kind: "struct" },
    },
  },
  "GhosttyTerminalScrollViewport": {
    size: 24, align: 8, isSized: false,
    fields: {
      "tag": { offset: 0, size: 4, kind: "int" },
      "value": { offset: 8, size: 16, kind: "struct" },
    },
  },
};

// enum GhosttyBuildInfo
export const GhosttyBuildInfoValues = {
  "GHOSTTY_BUILD_INFO_INVALID": 0,
  "GHOSTTY_BUILD_INFO_SIMD": 1,
  "GHOSTTY_BUILD_INFO_KITTY_GRAPHICS": 2,
  "GHOSTTY_BUILD_INFO_TMUX_CONTROL_MODE": 3,
  "GHOSTTY_BUILD_INFO_OPTIMIZE": 4,
  "GHOSTTY_BUILD_INFO_VERSION_STRING": 5,
  "GHOSTTY_BUILD_INFO_VERSION_MAJOR": 6,
  "GHOSTTY_BUILD_INFO_VERSION_MINOR": 7,
  "GHOSTTY_BUILD_INFO_VERSION_PATCH": 8,
  "GHOSTTY_BUILD_INFO_VERSION_PRE": 9,
  "GHOSTTY_BUILD_INFO_VERSION_BUILD": 10,
  "GHOSTTY_BUILD_INFO_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyCellContentTag
export const GhosttyCellContentTagValues = {
  "GHOSTTY_CELL_CONTENT_CODEPOINT": 0,
  "GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME": 1,
  "GHOSTTY_CELL_CONTENT_BG_COLOR_PALETTE": 2,
  "GHOSTTY_CELL_CONTENT_BG_COLOR_RGB": 3,
  "GHOSTTY_CELL_CONTENT_TAG_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyCellData
export const GhosttyCellDataValues = {
  "GHOSTTY_CELL_DATA_INVALID": 0,
  "GHOSTTY_CELL_DATA_CODEPOINT": 1,
  "GHOSTTY_CELL_DATA_CONTENT_TAG": 2,
  "GHOSTTY_CELL_DATA_WIDE": 3,
  "GHOSTTY_CELL_DATA_HAS_TEXT": 4,
  "GHOSTTY_CELL_DATA_HAS_STYLING": 5,
  "GHOSTTY_CELL_DATA_STYLE_ID": 6,
  "GHOSTTY_CELL_DATA_HAS_HYPERLINK": 7,
  "GHOSTTY_CELL_DATA_PROTECTED": 8,
  "GHOSTTY_CELL_DATA_SEMANTIC_CONTENT": 9,
  "GHOSTTY_CELL_DATA_COLOR_PALETTE": 10,
  "GHOSTTY_CELL_DATA_COLOR_RGB": 11,
  "GHOSTTY_CELL_DATA_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyCellSemanticContent
export const GhosttyCellSemanticContentValues = {
  "GHOSTTY_CELL_SEMANTIC_OUTPUT": 0,
  "GHOSTTY_CELL_SEMANTIC_INPUT": 1,
  "GHOSTTY_CELL_SEMANTIC_PROMPT": 2,
  "GHOSTTY_CELL_SEMANTIC_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyCellWide
export const GhosttyCellWideValues = {
  "GHOSTTY_CELL_WIDE_NARROW": 0,
  "GHOSTTY_CELL_WIDE_WIDE": 1,
  "GHOSTTY_CELL_WIDE_SPACER_TAIL": 2,
  "GHOSTTY_CELL_WIDE_SPACER_HEAD": 3,
  "GHOSTTY_CELL_WIDE_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyColorScheme
export const GhosttyColorSchemeValues = {
  "GHOSTTY_COLOR_SCHEME_LIGHT": 0,
  "GHOSTTY_COLOR_SCHEME_DARK": 1,
  "GHOSTTY_COLOR_SCHEME_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyFocusEvent
export const GhosttyFocusEventValues = {
  "GHOSTTY_FOCUS_GAINED": 0,
  "GHOSTTY_FOCUS_LOST": 1,
  "GHOSTTY_FOCUS_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyFormatterFormat
export const GhosttyFormatterFormatValues = {
  "GHOSTTY_FORMATTER_FORMAT_PLAIN": 0,
  "GHOSTTY_FORMATTER_FORMAT_VT": 1,
  "GHOSTTY_FORMATTER_FORMAT_HTML": 2,
  "GHOSTTY_FORMATTER_FORMAT_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyKey
export const GhosttyKeyValues = {
  "GHOSTTY_KEY_UNIDENTIFIED": 0,
  "GHOSTTY_KEY_BACKQUOTE": 1,
  "GHOSTTY_KEY_BACKSLASH": 2,
  "GHOSTTY_KEY_BRACKET_LEFT": 3,
  "GHOSTTY_KEY_BRACKET_RIGHT": 4,
  "GHOSTTY_KEY_COMMA": 5,
  "GHOSTTY_KEY_DIGIT_0": 6,
  "GHOSTTY_KEY_DIGIT_1": 7,
  "GHOSTTY_KEY_DIGIT_2": 8,
  "GHOSTTY_KEY_DIGIT_3": 9,
  "GHOSTTY_KEY_DIGIT_4": 10,
  "GHOSTTY_KEY_DIGIT_5": 11,
  "GHOSTTY_KEY_DIGIT_6": 12,
  "GHOSTTY_KEY_DIGIT_7": 13,
  "GHOSTTY_KEY_DIGIT_8": 14,
  "GHOSTTY_KEY_DIGIT_9": 15,
  "GHOSTTY_KEY_EQUAL": 16,
  "GHOSTTY_KEY_INTL_BACKSLASH": 17,
  "GHOSTTY_KEY_INTL_RO": 18,
  "GHOSTTY_KEY_INTL_YEN": 19,
  "GHOSTTY_KEY_A": 20,
  "GHOSTTY_KEY_B": 21,
  "GHOSTTY_KEY_C": 22,
  "GHOSTTY_KEY_D": 23,
  "GHOSTTY_KEY_E": 24,
  "GHOSTTY_KEY_F": 25,
  "GHOSTTY_KEY_G": 26,
  "GHOSTTY_KEY_H": 27,
  "GHOSTTY_KEY_I": 28,
  "GHOSTTY_KEY_J": 29,
  "GHOSTTY_KEY_K": 30,
  "GHOSTTY_KEY_L": 31,
  "GHOSTTY_KEY_M": 32,
  "GHOSTTY_KEY_N": 33,
  "GHOSTTY_KEY_O": 34,
  "GHOSTTY_KEY_P": 35,
  "GHOSTTY_KEY_Q": 36,
  "GHOSTTY_KEY_R": 37,
  "GHOSTTY_KEY_S": 38,
  "GHOSTTY_KEY_T": 39,
  "GHOSTTY_KEY_U": 40,
  "GHOSTTY_KEY_V": 41,
  "GHOSTTY_KEY_W": 42,
  "GHOSTTY_KEY_X": 43,
  "GHOSTTY_KEY_Y": 44,
  "GHOSTTY_KEY_Z": 45,
  "GHOSTTY_KEY_MINUS": 46,
  "GHOSTTY_KEY_PERIOD": 47,
  "GHOSTTY_KEY_QUOTE": 48,
  "GHOSTTY_KEY_SEMICOLON": 49,
  "GHOSTTY_KEY_SLASH": 50,
  "GHOSTTY_KEY_ALT_LEFT": 51,
  "GHOSTTY_KEY_ALT_RIGHT": 52,
  "GHOSTTY_KEY_BACKSPACE": 53,
  "GHOSTTY_KEY_CAPS_LOCK": 54,
  "GHOSTTY_KEY_CONTEXT_MENU": 55,
  "GHOSTTY_KEY_CONTROL_LEFT": 56,
  "GHOSTTY_KEY_CONTROL_RIGHT": 57,
  "GHOSTTY_KEY_ENTER": 58,
  "GHOSTTY_KEY_META_LEFT": 59,
  "GHOSTTY_KEY_META_RIGHT": 60,
  "GHOSTTY_KEY_SHIFT_LEFT": 61,
  "GHOSTTY_KEY_SHIFT_RIGHT": 62,
  "GHOSTTY_KEY_SPACE": 63,
  "GHOSTTY_KEY_TAB": 64,
  "GHOSTTY_KEY_CONVERT": 65,
  "GHOSTTY_KEY_KANA_MODE": 66,
  "GHOSTTY_KEY_NON_CONVERT": 67,
  "GHOSTTY_KEY_DELETE": 68,
  "GHOSTTY_KEY_END": 69,
  "GHOSTTY_KEY_HELP": 70,
  "GHOSTTY_KEY_HOME": 71,
  "GHOSTTY_KEY_INSERT": 72,
  "GHOSTTY_KEY_PAGE_DOWN": 73,
  "GHOSTTY_KEY_PAGE_UP": 74,
  "GHOSTTY_KEY_ARROW_DOWN": 75,
  "GHOSTTY_KEY_ARROW_LEFT": 76,
  "GHOSTTY_KEY_ARROW_RIGHT": 77,
  "GHOSTTY_KEY_ARROW_UP": 78,
  "GHOSTTY_KEY_NUM_LOCK": 79,
  "GHOSTTY_KEY_NUMPAD_0": 80,
  "GHOSTTY_KEY_NUMPAD_1": 81,
  "GHOSTTY_KEY_NUMPAD_2": 82,
  "GHOSTTY_KEY_NUMPAD_3": 83,
  "GHOSTTY_KEY_NUMPAD_4": 84,
  "GHOSTTY_KEY_NUMPAD_5": 85,
  "GHOSTTY_KEY_NUMPAD_6": 86,
  "GHOSTTY_KEY_NUMPAD_7": 87,
  "GHOSTTY_KEY_NUMPAD_8": 88,
  "GHOSTTY_KEY_NUMPAD_9": 89,
  "GHOSTTY_KEY_NUMPAD_ADD": 90,
  "GHOSTTY_KEY_NUMPAD_BACKSPACE": 91,
  "GHOSTTY_KEY_NUMPAD_CLEAR": 92,
  "GHOSTTY_KEY_NUMPAD_CLEAR_ENTRY": 93,
  "GHOSTTY_KEY_NUMPAD_COMMA": 94,
  "GHOSTTY_KEY_NUMPAD_DECIMAL": 95,
  "GHOSTTY_KEY_NUMPAD_DIVIDE": 96,
  "GHOSTTY_KEY_NUMPAD_ENTER": 97,
  "GHOSTTY_KEY_NUMPAD_EQUAL": 98,
  "GHOSTTY_KEY_NUMPAD_MEMORY_ADD": 99,
  "GHOSTTY_KEY_NUMPAD_MEMORY_CLEAR": 100,
  "GHOSTTY_KEY_NUMPAD_MEMORY_RECALL": 101,
  "GHOSTTY_KEY_NUMPAD_MEMORY_STORE": 102,
  "GHOSTTY_KEY_NUMPAD_MEMORY_SUBTRACT": 103,
  "GHOSTTY_KEY_NUMPAD_MULTIPLY": 104,
  "GHOSTTY_KEY_NUMPAD_PAREN_LEFT": 105,
  "GHOSTTY_KEY_NUMPAD_PAREN_RIGHT": 106,
  "GHOSTTY_KEY_NUMPAD_SUBTRACT": 107,
  "GHOSTTY_KEY_NUMPAD_SEPARATOR": 108,
  "GHOSTTY_KEY_NUMPAD_UP": 109,
  "GHOSTTY_KEY_NUMPAD_DOWN": 110,
  "GHOSTTY_KEY_NUMPAD_RIGHT": 111,
  "GHOSTTY_KEY_NUMPAD_LEFT": 112,
  "GHOSTTY_KEY_NUMPAD_BEGIN": 113,
  "GHOSTTY_KEY_NUMPAD_HOME": 114,
  "GHOSTTY_KEY_NUMPAD_END": 115,
  "GHOSTTY_KEY_NUMPAD_INSERT": 116,
  "GHOSTTY_KEY_NUMPAD_DELETE": 117,
  "GHOSTTY_KEY_NUMPAD_PAGE_UP": 118,
  "GHOSTTY_KEY_NUMPAD_PAGE_DOWN": 119,
  "GHOSTTY_KEY_ESCAPE": 120,
  "GHOSTTY_KEY_F1": 121,
  "GHOSTTY_KEY_F2": 122,
  "GHOSTTY_KEY_F3": 123,
  "GHOSTTY_KEY_F4": 124,
  "GHOSTTY_KEY_F5": 125,
  "GHOSTTY_KEY_F6": 126,
  "GHOSTTY_KEY_F7": 127,
  "GHOSTTY_KEY_F8": 128,
  "GHOSTTY_KEY_F9": 129,
  "GHOSTTY_KEY_F10": 130,
  "GHOSTTY_KEY_F11": 131,
  "GHOSTTY_KEY_F12": 132,
  "GHOSTTY_KEY_F13": 133,
  "GHOSTTY_KEY_F14": 134,
  "GHOSTTY_KEY_F15": 135,
  "GHOSTTY_KEY_F16": 136,
  "GHOSTTY_KEY_F17": 137,
  "GHOSTTY_KEY_F18": 138,
  "GHOSTTY_KEY_F19": 139,
  "GHOSTTY_KEY_F20": 140,
  "GHOSTTY_KEY_F21": 141,
  "GHOSTTY_KEY_F22": 142,
  "GHOSTTY_KEY_F23": 143,
  "GHOSTTY_KEY_F24": 144,
  "GHOSTTY_KEY_F25": 145,
  "GHOSTTY_KEY_FN": 146,
  "GHOSTTY_KEY_FN_LOCK": 147,
  "GHOSTTY_KEY_PRINT_SCREEN": 148,
  "GHOSTTY_KEY_SCROLL_LOCK": 149,
  "GHOSTTY_KEY_PAUSE": 150,
  "GHOSTTY_KEY_BROWSER_BACK": 151,
  "GHOSTTY_KEY_BROWSER_FAVORITES": 152,
  "GHOSTTY_KEY_BROWSER_FORWARD": 153,
  "GHOSTTY_KEY_BROWSER_HOME": 154,
  "GHOSTTY_KEY_BROWSER_REFRESH": 155,
  "GHOSTTY_KEY_BROWSER_SEARCH": 156,
  "GHOSTTY_KEY_BROWSER_STOP": 157,
  "GHOSTTY_KEY_EJECT": 158,
  "GHOSTTY_KEY_LAUNCH_APP_1": 159,
  "GHOSTTY_KEY_LAUNCH_APP_2": 160,
  "GHOSTTY_KEY_LAUNCH_MAIL": 161,
  "GHOSTTY_KEY_MEDIA_PLAY_PAUSE": 162,
  "GHOSTTY_KEY_MEDIA_SELECT": 163,
  "GHOSTTY_KEY_MEDIA_STOP": 164,
  "GHOSTTY_KEY_MEDIA_TRACK_NEXT": 165,
  "GHOSTTY_KEY_MEDIA_TRACK_PREVIOUS": 166,
  "GHOSTTY_KEY_POWER": 167,
  "GHOSTTY_KEY_SLEEP": 168,
  "GHOSTTY_KEY_AUDIO_VOLUME_DOWN": 169,
  "GHOSTTY_KEY_AUDIO_VOLUME_MUTE": 170,
  "GHOSTTY_KEY_AUDIO_VOLUME_UP": 171,
  "GHOSTTY_KEY_WAKE_UP": 172,
  "GHOSTTY_KEY_COPY": 173,
  "GHOSTTY_KEY_CUT": 174,
  "GHOSTTY_KEY_PASTE": 175,
  "GHOSTTY_KEY_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyKeyAction
export const GhosttyKeyActionValues = {
  "GHOSTTY_KEY_ACTION_RELEASE": 0,
  "GHOSTTY_KEY_ACTION_PRESS": 1,
  "GHOSTTY_KEY_ACTION_REPEAT": 2,
  "GHOSTTY_KEY_ACTION_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyKeyEncoderOption
export const GhosttyKeyEncoderOptionValues = {
  "GHOSTTY_KEY_ENCODER_OPT_CURSOR_KEY_APPLICATION": 0,
  "GHOSTTY_KEY_ENCODER_OPT_KEYPAD_KEY_APPLICATION": 1,
  "GHOSTTY_KEY_ENCODER_OPT_IGNORE_KEYPAD_WITH_NUMLOCK": 2,
  "GHOSTTY_KEY_ENCODER_OPT_ALT_ESC_PREFIX": 3,
  "GHOSTTY_KEY_ENCODER_OPT_MODIFY_OTHER_KEYS_STATE_2": 4,
  "GHOSTTY_KEY_ENCODER_OPT_KITTY_FLAGS": 5,
  "GHOSTTY_KEY_ENCODER_OPT_MACOS_OPTION_AS_ALT": 6,
  "GHOSTTY_KEY_ENCODER_OPT_BACKARROW_KEY_MODE": 7,
  "GHOSTTY_KEY_ENCODER_OPT_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyKittyGraphicsData
export const GhosttyKittyGraphicsDataValues = {
  "GHOSTTY_KITTY_GRAPHICS_DATA_INVALID": 0,
  "GHOSTTY_KITTY_GRAPHICS_DATA_PLACEMENT_ITERATOR": 1,
  "GHOSTTY_KITTY_GRAPHICS_DATA_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyKittyGraphicsImageData
export const GhosttyKittyGraphicsImageDataValues = {
  "GHOSTTY_KITTY_IMAGE_DATA_INVALID": 0,
  "GHOSTTY_KITTY_IMAGE_DATA_ID": 1,
  "GHOSTTY_KITTY_IMAGE_DATA_NUMBER": 2,
  "GHOSTTY_KITTY_IMAGE_DATA_WIDTH": 3,
  "GHOSTTY_KITTY_IMAGE_DATA_HEIGHT": 4,
  "GHOSTTY_KITTY_IMAGE_DATA_FORMAT": 5,
  "GHOSTTY_KITTY_IMAGE_DATA_COMPRESSION": 6,
  "GHOSTTY_KITTY_IMAGE_DATA_DATA_PTR": 7,
  "GHOSTTY_KITTY_IMAGE_DATA_DATA_LEN": 8,
  "GHOSTTY_KITTY_IMAGE_DATA_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyKittyGraphicsPlacementData
export const GhosttyKittyGraphicsPlacementDataValues = {
  "GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_INVALID": 0,
  "GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_IMAGE_ID": 1,
  "GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_PLACEMENT_ID": 2,
  "GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_IS_VIRTUAL": 3,
  "GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_X_OFFSET": 4,
  "GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_Y_OFFSET": 5,
  "GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_SOURCE_X": 6,
  "GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_SOURCE_Y": 7,
  "GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_SOURCE_WIDTH": 8,
  "GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_SOURCE_HEIGHT": 9,
  "GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_COLUMNS": 10,
  "GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_ROWS": 11,
  "GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_Z": 12,
  "GHOSTTY_KITTY_GRAPHICS_PLACEMENT_DATA_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyKittyGraphicsPlacementIteratorOption
export const GhosttyKittyGraphicsPlacementIteratorOptionValues = {
  "GHOSTTY_KITTY_GRAPHICS_PLACEMENT_ITERATOR_OPTION_LAYER": 0,
  "GHOSTTY_KITTY_GRAPHICS_PLACEMENT_ITERATOR_OPTION_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyKittyImageCompression
export const GhosttyKittyImageCompressionValues = {
  "GHOSTTY_KITTY_IMAGE_COMPRESSION_NONE": 0,
  "GHOSTTY_KITTY_IMAGE_COMPRESSION_ZLIB_DEFLATE": 1,
  "GHOSTTY_KITTY_IMAGE_COMPRESSION_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyKittyImageFormat
export const GhosttyKittyImageFormatValues = {
  "GHOSTTY_KITTY_IMAGE_FORMAT_RGB": 0,
  "GHOSTTY_KITTY_IMAGE_FORMAT_RGBA": 1,
  "GHOSTTY_KITTY_IMAGE_FORMAT_PNG": 2,
  "GHOSTTY_KITTY_IMAGE_FORMAT_GRAY_ALPHA": 3,
  "GHOSTTY_KITTY_IMAGE_FORMAT_GRAY": 4,
  "GHOSTTY_KITTY_IMAGE_FORMAT_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyKittyPlacementLayer
export const GhosttyKittyPlacementLayerValues = {
  "GHOSTTY_KITTY_PLACEMENT_LAYER_ALL": 0,
  "GHOSTTY_KITTY_PLACEMENT_LAYER_BELOW_BG": 1,
  "GHOSTTY_KITTY_PLACEMENT_LAYER_BELOW_TEXT": 2,
  "GHOSTTY_KITTY_PLACEMENT_LAYER_ABOVE_TEXT": 3,
  "GHOSTTY_KITTY_PLACEMENT_LAYER_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyModeReportState
export const GhosttyModeReportStateValues = {
  "GHOSTTY_MODE_REPORT_NOT_RECOGNIZED": 0,
  "GHOSTTY_MODE_REPORT_SET": 1,
  "GHOSTTY_MODE_REPORT_RESET": 2,
  "GHOSTTY_MODE_REPORT_PERMANENTLY_SET": 3,
  "GHOSTTY_MODE_REPORT_PERMANENTLY_RESET": 4,
  "GHOSTTY_MODE_REPORT_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyMouseAction
export const GhosttyMouseActionValues = {
  "GHOSTTY_MOUSE_ACTION_PRESS": 0,
  "GHOSTTY_MOUSE_ACTION_RELEASE": 1,
  "GHOSTTY_MOUSE_ACTION_MOTION": 2,
  "GHOSTTY_MOUSE_ACTION_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyMouseButton
export const GhosttyMouseButtonValues = {
  "GHOSTTY_MOUSE_BUTTON_UNKNOWN": 0,
  "GHOSTTY_MOUSE_BUTTON_LEFT": 1,
  "GHOSTTY_MOUSE_BUTTON_RIGHT": 2,
  "GHOSTTY_MOUSE_BUTTON_MIDDLE": 3,
  "GHOSTTY_MOUSE_BUTTON_FOUR": 4,
  "GHOSTTY_MOUSE_BUTTON_FIVE": 5,
  "GHOSTTY_MOUSE_BUTTON_SIX": 6,
  "GHOSTTY_MOUSE_BUTTON_SEVEN": 7,
  "GHOSTTY_MOUSE_BUTTON_EIGHT": 8,
  "GHOSTTY_MOUSE_BUTTON_NINE": 9,
  "GHOSTTY_MOUSE_BUTTON_TEN": 10,
  "GHOSTTY_MOUSE_BUTTON_ELEVEN": 11,
  "GHOSTTY_MOUSE_BUTTON_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyMouseEncoderOption
export const GhosttyMouseEncoderOptionValues = {
  "GHOSTTY_MOUSE_ENCODER_OPT_EVENT": 0,
  "GHOSTTY_MOUSE_ENCODER_OPT_FORMAT": 1,
  "GHOSTTY_MOUSE_ENCODER_OPT_SIZE": 2,
  "GHOSTTY_MOUSE_ENCODER_OPT_ANY_BUTTON_PRESSED": 3,
  "GHOSTTY_MOUSE_ENCODER_OPT_TRACK_LAST_CELL": 4,
  "GHOSTTY_MOUSE_ENCODER_OPT_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyMouseFormat
export const GhosttyMouseFormatValues = {
  "GHOSTTY_MOUSE_FORMAT_X10": 0,
  "GHOSTTY_MOUSE_FORMAT_UTF8": 1,
  "GHOSTTY_MOUSE_FORMAT_SGR": 2,
  "GHOSTTY_MOUSE_FORMAT_URXVT": 3,
  "GHOSTTY_MOUSE_FORMAT_SGR_PIXELS": 4,
  "GHOSTTY_MOUSE_FORMAT_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyMouseTrackingMode
export const GhosttyMouseTrackingModeValues = {
  "GHOSTTY_MOUSE_TRACKING_NONE": 0,
  "GHOSTTY_MOUSE_TRACKING_X10": 1,
  "GHOSTTY_MOUSE_TRACKING_NORMAL": 2,
  "GHOSTTY_MOUSE_TRACKING_BUTTON": 3,
  "GHOSTTY_MOUSE_TRACKING_ANY": 4,
  "GHOSTTY_MOUSE_TRACKING_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyOptimizeMode
export const GhosttyOptimizeModeValues = {
  "GHOSTTY_OPTIMIZE_DEBUG": 0,
  "GHOSTTY_OPTIMIZE_RELEASE_SAFE": 1,
  "GHOSTTY_OPTIMIZE_RELEASE_SMALL": 2,
  "GHOSTTY_OPTIMIZE_RELEASE_FAST": 3,
  "GHOSTTY_OPTIMIZE_MODE_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyOptionAsAlt
export const GhosttyOptionAsAltValues = {
  "GHOSTTY_OPTION_AS_ALT_FALSE": 0,
  "GHOSTTY_OPTION_AS_ALT_TRUE": 1,
  "GHOSTTY_OPTION_AS_ALT_LEFT": 2,
  "GHOSTTY_OPTION_AS_ALT_RIGHT": 3,
  "GHOSTTY_OPTION_AS_ALT_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyOscCommandData
export const GhosttyOscCommandDataValues = {
  "GHOSTTY_OSC_DATA_INVALID": 0,
  "GHOSTTY_OSC_DATA_CHANGE_WINDOW_TITLE_STR": 1,
  "GHOSTTY_OSC_DATA_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyOscCommandType
export const GhosttyOscCommandTypeValues = {
  "GHOSTTY_OSC_COMMAND_INVALID": 0,
  "GHOSTTY_OSC_COMMAND_CHANGE_WINDOW_TITLE": 1,
  "GHOSTTY_OSC_COMMAND_CHANGE_WINDOW_ICON": 2,
  "GHOSTTY_OSC_COMMAND_SEMANTIC_PROMPT": 3,
  "GHOSTTY_OSC_COMMAND_CLIPBOARD_CONTENTS": 4,
  "GHOSTTY_OSC_COMMAND_REPORT_PWD": 5,
  "GHOSTTY_OSC_COMMAND_MOUSE_SHAPE": 6,
  "GHOSTTY_OSC_COMMAND_COLOR_OPERATION": 7,
  "GHOSTTY_OSC_COMMAND_KITTY_COLOR_PROTOCOL": 8,
  "GHOSTTY_OSC_COMMAND_SHOW_DESKTOP_NOTIFICATION": 9,
  "GHOSTTY_OSC_COMMAND_HYPERLINK_START": 10,
  "GHOSTTY_OSC_COMMAND_HYPERLINK_END": 11,
  "GHOSTTY_OSC_COMMAND_CONEMU_SLEEP": 12,
  "GHOSTTY_OSC_COMMAND_CONEMU_SHOW_MESSAGE_BOX": 13,
  "GHOSTTY_OSC_COMMAND_CONEMU_CHANGE_TAB_TITLE": 14,
  "GHOSTTY_OSC_COMMAND_CONEMU_PROGRESS_REPORT": 15,
  "GHOSTTY_OSC_COMMAND_CONEMU_WAIT_INPUT": 16,
  "GHOSTTY_OSC_COMMAND_CONEMU_GUIMACRO": 17,
  "GHOSTTY_OSC_COMMAND_CONEMU_RUN_PROCESS": 18,
  "GHOSTTY_OSC_COMMAND_CONEMU_OUTPUT_ENVIRONMENT_VARIABLE": 19,
  "GHOSTTY_OSC_COMMAND_CONEMU_XTERM_EMULATION": 20,
  "GHOSTTY_OSC_COMMAND_CONEMU_COMMENT": 21,
  "GHOSTTY_OSC_COMMAND_KITTY_TEXT_SIZING": 22,
  "GHOSTTY_OSC_COMMAND_TYPE_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyPointTag
export const GhosttyPointTagValues = {
  "GHOSTTY_POINT_TAG_ACTIVE": 0,
  "GHOSTTY_POINT_TAG_VIEWPORT": 1,
  "GHOSTTY_POINT_TAG_SCREEN": 2,
  "GHOSTTY_POINT_TAG_HISTORY": 3,
  "GHOSTTY_POINT_TAG_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyRenderStateCursorVisualStyle
export const GhosttyRenderStateCursorVisualStyleValues = {
  "GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BAR": 0,
  "GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK": 1,
  "GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_UNDERLINE": 2,
  "GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK_HOLLOW": 3,
  "GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyRenderStateData
export const GhosttyRenderStateDataValues = {
  "GHOSTTY_RENDER_STATE_DATA_INVALID": 0,
  "GHOSTTY_RENDER_STATE_DATA_COLS": 1,
  "GHOSTTY_RENDER_STATE_DATA_ROWS": 2,
  "GHOSTTY_RENDER_STATE_DATA_DIRTY": 3,
  "GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR": 4,
  "GHOSTTY_RENDER_STATE_DATA_COLOR_BACKGROUND": 5,
  "GHOSTTY_RENDER_STATE_DATA_COLOR_FOREGROUND": 6,
  "GHOSTTY_RENDER_STATE_DATA_COLOR_CURSOR": 7,
  "GHOSTTY_RENDER_STATE_DATA_COLOR_CURSOR_HAS_VALUE": 8,
  "GHOSTTY_RENDER_STATE_DATA_COLOR_PALETTE": 9,
  "GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE": 10,
  "GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE": 11,
  "GHOSTTY_RENDER_STATE_DATA_CURSOR_BLINKING": 12,
  "GHOSTTY_RENDER_STATE_DATA_CURSOR_PASSWORD_INPUT": 13,
  "GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE": 14,
  "GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X": 15,
  "GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y": 16,
  "GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_WIDE_TAIL": 17,
  "GHOSTTY_RENDER_STATE_DATA_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyRenderStateDirty
export const GhosttyRenderStateDirtyValues = {
  "GHOSTTY_RENDER_STATE_DIRTY_FALSE": 0,
  "GHOSTTY_RENDER_STATE_DIRTY_PARTIAL": 1,
  "GHOSTTY_RENDER_STATE_DIRTY_FULL": 2,
  "GHOSTTY_RENDER_STATE_DIRTY_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyRenderStateOption
export const GhosttyRenderStateOptionValues = {
  "GHOSTTY_RENDER_STATE_OPTION_DIRTY": 0,
  "GHOSTTY_RENDER_STATE_OPTION_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyRenderStateRowCellsData
export const GhosttyRenderStateRowCellsDataValues = {
  "GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_INVALID": 0,
  "GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW": 1,
  "GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE": 2,
  "GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN": 3,
  "GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF": 4,
  "GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR": 5,
  "GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR": 6,
  "GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyRenderStateRowData
export const GhosttyRenderStateRowDataValues = {
  "GHOSTTY_RENDER_STATE_ROW_DATA_INVALID": 0,
  "GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY": 1,
  "GHOSTTY_RENDER_STATE_ROW_DATA_RAW": 2,
  "GHOSTTY_RENDER_STATE_ROW_DATA_CELLS": 3,
  "GHOSTTY_RENDER_STATE_ROW_DATA_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyRenderStateRowOption
export const GhosttyRenderStateRowOptionValues = {
  "GHOSTTY_RENDER_STATE_ROW_OPTION_DIRTY": 0,
  "GHOSTTY_RENDER_STATE_ROW_OPTION_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyResult
export const GhosttyResultValues = {
  "GHOSTTY_SUCCESS": 0,
  "GHOSTTY_OUT_OF_MEMORY": -1,
  "GHOSTTY_INVALID_VALUE": -2,
  "GHOSTTY_OUT_OF_SPACE": -3,
  "GHOSTTY_NO_VALUE": -4,
  "GHOSTTY_RESULT_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyRowData
export const GhosttyRowDataValues = {
  "GHOSTTY_ROW_DATA_INVALID": 0,
  "GHOSTTY_ROW_DATA_WRAP": 1,
  "GHOSTTY_ROW_DATA_WRAP_CONTINUATION": 2,
  "GHOSTTY_ROW_DATA_GRAPHEME": 3,
  "GHOSTTY_ROW_DATA_STYLED": 4,
  "GHOSTTY_ROW_DATA_HYPERLINK": 5,
  "GHOSTTY_ROW_DATA_SEMANTIC_PROMPT": 6,
  "GHOSTTY_ROW_DATA_KITTY_VIRTUAL_PLACEHOLDER": 7,
  "GHOSTTY_ROW_DATA_DIRTY": 8,
  "GHOSTTY_ROW_DATA_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyRowSemanticPrompt
export const GhosttyRowSemanticPromptValues = {
  "GHOSTTY_ROW_SEMANTIC_NONE": 0,
  "GHOSTTY_ROW_SEMANTIC_PROMPT": 1,
  "GHOSTTY_ROW_SEMANTIC_PROMPT_CONTINUATION": 2,
  "GHOSTTY_ROW_SEMANTIC_MAX_VALUE": 2147483647,
} as const;

// enum GhosttySgrAttributeTag
export const GhosttySgrAttributeTagValues = {
  "GHOSTTY_SGR_ATTR_UNSET": 0,
  "GHOSTTY_SGR_ATTR_UNKNOWN": 1,
  "GHOSTTY_SGR_ATTR_BOLD": 2,
  "GHOSTTY_SGR_ATTR_RESET_BOLD": 3,
  "GHOSTTY_SGR_ATTR_ITALIC": 4,
  "GHOSTTY_SGR_ATTR_RESET_ITALIC": 5,
  "GHOSTTY_SGR_ATTR_FAINT": 6,
  "GHOSTTY_SGR_ATTR_UNDERLINE": 7,
  "GHOSTTY_SGR_ATTR_UNDERLINE_COLOR": 8,
  "GHOSTTY_SGR_ATTR_UNDERLINE_COLOR_256": 9,
  "GHOSTTY_SGR_ATTR_RESET_UNDERLINE_COLOR": 10,
  "GHOSTTY_SGR_ATTR_OVERLINE": 11,
  "GHOSTTY_SGR_ATTR_RESET_OVERLINE": 12,
  "GHOSTTY_SGR_ATTR_BLINK": 13,
  "GHOSTTY_SGR_ATTR_RESET_BLINK": 14,
  "GHOSTTY_SGR_ATTR_INVERSE": 15,
  "GHOSTTY_SGR_ATTR_RESET_INVERSE": 16,
  "GHOSTTY_SGR_ATTR_INVISIBLE": 17,
  "GHOSTTY_SGR_ATTR_RESET_INVISIBLE": 18,
  "GHOSTTY_SGR_ATTR_STRIKETHROUGH": 19,
  "GHOSTTY_SGR_ATTR_RESET_STRIKETHROUGH": 20,
  "GHOSTTY_SGR_ATTR_DIRECT_COLOR_FG": 21,
  "GHOSTTY_SGR_ATTR_DIRECT_COLOR_BG": 22,
  "GHOSTTY_SGR_ATTR_BG_8": 23,
  "GHOSTTY_SGR_ATTR_FG_8": 24,
  "GHOSTTY_SGR_ATTR_RESET_FG": 25,
  "GHOSTTY_SGR_ATTR_RESET_BG": 26,
  "GHOSTTY_SGR_ATTR_BRIGHT_BG_8": 27,
  "GHOSTTY_SGR_ATTR_BRIGHT_FG_8": 28,
  "GHOSTTY_SGR_ATTR_BG_256": 29,
  "GHOSTTY_SGR_ATTR_FG_256": 30,
  "GHOSTTY_SGR_ATTR_MAX_VALUE": 2147483647,
} as const;

// enum GhosttySgrUnderline
export const GhosttySgrUnderlineValues = {
  "GHOSTTY_SGR_UNDERLINE_NONE": 0,
  "GHOSTTY_SGR_UNDERLINE_SINGLE": 1,
  "GHOSTTY_SGR_UNDERLINE_DOUBLE": 2,
  "GHOSTTY_SGR_UNDERLINE_CURLY": 3,
  "GHOSTTY_SGR_UNDERLINE_DOTTED": 4,
  "GHOSTTY_SGR_UNDERLINE_DASHED": 5,
  "GHOSTTY_SGR_UNDERLINE_MAX_VALUE": 2147483647,
} as const;

// enum GhosttySizeReportStyle
export const GhosttySizeReportStyleValues = {
  "GHOSTTY_SIZE_REPORT_MODE_2048": 0,
  "GHOSTTY_SIZE_REPORT_CSI_14_T": 1,
  "GHOSTTY_SIZE_REPORT_CSI_16_T": 2,
  "GHOSTTY_SIZE_REPORT_CSI_18_T": 3,
  "GHOSTTY_SIZE_REPORT_STYLE_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyStyleColorTag
export const GhosttyStyleColorTagValues = {
  "GHOSTTY_STYLE_COLOR_NONE": 0,
  "GHOSTTY_STYLE_COLOR_PALETTE": 1,
  "GHOSTTY_STYLE_COLOR_RGB": 2,
  "GHOSTTY_STYLE_COLOR_TAG_MAX_VALUE": 2147483647,
} as const;

// enum GhosttySysLogLevel
export const GhosttySysLogLevelValues = {
  "GHOSTTY_SYS_LOG_LEVEL_ERROR": 0,
  "GHOSTTY_SYS_LOG_LEVEL_WARNING": 1,
  "GHOSTTY_SYS_LOG_LEVEL_INFO": 2,
  "GHOSTTY_SYS_LOG_LEVEL_DEBUG": 3,
  "GHOSTTY_SYS_LOG_LEVEL_MAX_VALUE": 2147483647,
} as const;

// enum GhosttySysOption
export const GhosttySysOptionValues = {
  "GHOSTTY_SYS_OPT_USERDATA": 0,
  "GHOSTTY_SYS_OPT_DECODE_PNG": 1,
  "GHOSTTY_SYS_OPT_LOG": 2,
  "GHOSTTY_SYS_OPT_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyTerminalData
export const GhosttyTerminalDataValues = {
  "GHOSTTY_TERMINAL_DATA_INVALID": 0,
  "GHOSTTY_TERMINAL_DATA_COLS": 1,
  "GHOSTTY_TERMINAL_DATA_ROWS": 2,
  "GHOSTTY_TERMINAL_DATA_CURSOR_X": 3,
  "GHOSTTY_TERMINAL_DATA_CURSOR_Y": 4,
  "GHOSTTY_TERMINAL_DATA_CURSOR_PENDING_WRAP": 5,
  "GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN": 6,
  "GHOSTTY_TERMINAL_DATA_CURSOR_VISIBLE": 7,
  "GHOSTTY_TERMINAL_DATA_KITTY_KEYBOARD_FLAGS": 8,
  "GHOSTTY_TERMINAL_DATA_SCROLLBAR": 9,
  "GHOSTTY_TERMINAL_DATA_CURSOR_STYLE": 10,
  "GHOSTTY_TERMINAL_DATA_MOUSE_TRACKING": 11,
  "GHOSTTY_TERMINAL_DATA_TITLE": 12,
  "GHOSTTY_TERMINAL_DATA_PWD": 13,
  "GHOSTTY_TERMINAL_DATA_TOTAL_ROWS": 14,
  "GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS": 15,
  "GHOSTTY_TERMINAL_DATA_WIDTH_PX": 16,
  "GHOSTTY_TERMINAL_DATA_HEIGHT_PX": 17,
  "GHOSTTY_TERMINAL_DATA_COLOR_FOREGROUND": 18,
  "GHOSTTY_TERMINAL_DATA_COLOR_BACKGROUND": 19,
  "GHOSTTY_TERMINAL_DATA_COLOR_CURSOR": 20,
  "GHOSTTY_TERMINAL_DATA_COLOR_PALETTE": 21,
  "GHOSTTY_TERMINAL_DATA_COLOR_FOREGROUND_DEFAULT": 22,
  "GHOSTTY_TERMINAL_DATA_COLOR_BACKGROUND_DEFAULT": 23,
  "GHOSTTY_TERMINAL_DATA_COLOR_CURSOR_DEFAULT": 24,
  "GHOSTTY_TERMINAL_DATA_COLOR_PALETTE_DEFAULT": 25,
  "GHOSTTY_TERMINAL_DATA_KITTY_IMAGE_STORAGE_LIMIT": 26,
  "GHOSTTY_TERMINAL_DATA_KITTY_IMAGE_MEDIUM_FILE": 27,
  "GHOSTTY_TERMINAL_DATA_KITTY_IMAGE_MEDIUM_TEMP_FILE": 28,
  "GHOSTTY_TERMINAL_DATA_KITTY_IMAGE_MEDIUM_SHARED_MEM": 29,
  "GHOSTTY_TERMINAL_DATA_KITTY_GRAPHICS": 30,
  "GHOSTTY_TERMINAL_DATA_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyTerminalOption
export const GhosttyTerminalOptionValues = {
  "GHOSTTY_TERMINAL_OPT_USERDATA": 0,
  "GHOSTTY_TERMINAL_OPT_WRITE_PTY": 1,
  "GHOSTTY_TERMINAL_OPT_BELL": 2,
  "GHOSTTY_TERMINAL_OPT_ENQUIRY": 3,
  "GHOSTTY_TERMINAL_OPT_XTVERSION": 4,
  "GHOSTTY_TERMINAL_OPT_TITLE_CHANGED": 5,
  "GHOSTTY_TERMINAL_OPT_SIZE": 6,
  "GHOSTTY_TERMINAL_OPT_COLOR_SCHEME": 7,
  "GHOSTTY_TERMINAL_OPT_DEVICE_ATTRIBUTES": 8,
  "GHOSTTY_TERMINAL_OPT_TITLE": 9,
  "GHOSTTY_TERMINAL_OPT_PWD": 10,
  "GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND": 11,
  "GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND": 12,
  "GHOSTTY_TERMINAL_OPT_COLOR_CURSOR": 13,
  "GHOSTTY_TERMINAL_OPT_COLOR_PALETTE": 14,
  "GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_STORAGE_LIMIT": 15,
  "GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_FILE": 16,
  "GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_TEMP_FILE": 17,
  "GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_MEDIUM_SHARED_MEM": 18,
  "GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES": 19,
  "GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES_KITTY": 20,
  "GHOSTTY_TERMINAL_OPT_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyTerminalScreen
export const GhosttyTerminalScreenValues = {
  "GHOSTTY_TERMINAL_SCREEN_PRIMARY": 0,
  "GHOSTTY_TERMINAL_SCREEN_ALTERNATE": 1,
  "GHOSTTY_TERMINAL_SCREEN_MAX_VALUE": 2147483647,
} as const;

// enum GhosttyTerminalScrollViewportTag
export const GhosttyTerminalScrollViewportTagValues = {
  "GHOSTTY_SCROLL_VIEWPORT_TOP": 0,
  "GHOSTTY_SCROLL_VIEWPORT_BOTTOM": 1,
  "GHOSTTY_SCROLL_VIEWPORT_DELTA": 2,
  "GHOSTTY_SCROLL_VIEWPORT_MAX_VALUE": 2147483647,
} as const;

// GhosttyResult numeric → TS GhosttyErrorCode. Drives checkResult().
export const resultCodeByValue: Record<number, string> = {
  "0": "ok",
  "-1": "out_of_memory",
  "-2": "invalid_value",
  "-3": "out_of_space",
  "-4": "no_value",
};

// Mode tags — parsed from #define GHOSTTY_MODE_<NAME> macros in vt/modes.h.
// Values are packed uint16: `rawValue | (ansi ? 1<<15 : 0)`. See ABI discovery §8.
export const modeNames = [
  "_132_column",
  "alt_esc_prefix",
  "alt_screen",
  "alt_screen_legacy",
  "alt_screen_save",
  "alt_scroll",
  "alt_sends_esc",
  "any_mouse",
  "autorepeat",
  "backarrow_key_mode",
  "bracketed_paste",
  "button_mouse",
  "color_scheme_report",
  "cursor_blinking",
  "cursor_visible",
  "decckm",
  "enable_mode_3",
  "focus_event",
  "grapheme_cluster",
  "in_band_resize",
  "insert",
  "kam",
  "keypad_keys",
  "left_right_margin",
  "linefeed",
  "normal_mouse",
  "numlock_keypad",
  "origin",
  "reverse_colors",
  "reverse_wrap",
  "reverse_wrap_ext",
  "save_cursor",
  "sgr_mouse",
  "sgr_pixels_mouse",
  "slow_scroll",
  "srm",
  "sync_output",
  "urxvt_mouse",
  "utf8_mouse",
  "wraparound",
  "x10_mouse",
] as const;
export type ModeName = typeof modeNames[number];
export const modeTagByName: Record<ModeName, number> = {
  "_132_column": 3,
  "alt_esc_prefix": 1036,
  "alt_screen": 1047,
  "alt_screen_legacy": 47,
  "alt_screen_save": 1049,
  "alt_scroll": 1007,
  "alt_sends_esc": 1039,
  "any_mouse": 1003,
  "autorepeat": 8,
  "backarrow_key_mode": 67,
  "bracketed_paste": 2004,
  "button_mouse": 1002,
  "color_scheme_report": 2031,
  "cursor_blinking": 12,
  "cursor_visible": 25,
  "decckm": 1,
  "enable_mode_3": 40,
  "focus_event": 1004,
  "grapheme_cluster": 2027,
  "in_band_resize": 2048,
  "insert": 32772,
  "kam": 32770,
  "keypad_keys": 66,
  "left_right_margin": 69,
  "linefeed": 32788,
  "normal_mouse": 1000,
  "numlock_keypad": 1035,
  "origin": 6,
  "reverse_colors": 5,
  "reverse_wrap": 45,
  "reverse_wrap_ext": 1045,
  "save_cursor": 1048,
  "sgr_mouse": 1006,
  "sgr_pixels_mouse": 1016,
  "slow_scroll": 4,
  "srm": 32780,
  "sync_output": 2026,
  "urxvt_mouse": 1015,
  "utf8_mouse": 1005,
  "wraparound": 7,
  "x10_mouse": 9,
};

export const formatterFormatByName: Record<"plain" | "vt" | "html", number | null> = {
  "plain": 0,
  "vt":    1,
  "html":  2,
};


/** By-value entry points detected in libghostty-vt headers.
 * Each must have a corresponding _p wrapper in native/shim.c.
 * If this list grows on a pin bump, add the new wrapper before merging.
 * Auto-generated; do not hand-edit. */
export const byValueEntryPoints = [
  "ghostty_formatter_terminal_new: GhosttyFormatterTerminalOptions",
  "ghostty_terminal_grid_ref: GhosttyPoint",
  "ghostty_terminal_new: GhosttyTerminalOptions",
  "ghostty_terminal_scroll_viewport: GhosttyTerminalScrollViewport",
] as const;
