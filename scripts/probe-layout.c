/*
 * ts-libghostty struct-layout probe.
 * Compiled against the pinned Ghostty headers; emits JSON describing the
 * ABI of every struct the binding writes or reads.
 *
 * To add a struct: add a new probe_struct_<name>() function that prints one
 * JSON object into the array, then call it from main(). For each field use
 * the emit_field_<kind>() helper matching the C type.
 */
#include <stdio.h>
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

#include "ghostty/vt.h"
#include "ghostty/vt/color.h"
#include "ghostty/vt/style.h"
#include "ghostty/vt/point.h"
#include "ghostty/vt/grid_ref.h"
#include "ghostty/vt/render.h"
#include "ghostty/vt/terminal.h"

static int first_entry = 1;

static void begin_entry(void) {
  if (!first_entry) printf(",\n");
  first_entry = 0;
}

static void emit_struct(const char *name, size_t size, size_t align, int is_sized) {
  begin_entry();
  printf("  {\n");
  printf("    \"name\": \"%s\",\n", name);
  printf("    \"size\": %zu,\n", size);
  printf("    \"align\": %zu,\n", align);
  printf("    \"isSized\": %s,\n", is_sized ? "true" : "false");
  printf("    \"fields\": [");
}

static int first_field;

static void emit_field(const char *name, size_t offset, size_t size, const char *kind) {
  if (!first_field) printf(",");
  first_field = 0;
  printf("\n      {\"name\": \"%s\", \"offset\": %zu, \"size\": %zu, \"kind\": \"%s\"}",
         name, offset, size, kind);
}

#define EMIT_UINT(S, F)   emit_field(#F, offsetof(S, F), sizeof(((S*)0)->F), "uint")
#define EMIT_INT(S, F)    emit_field(#F, offsetof(S, F), sizeof(((S*)0)->F), "int")
#define EMIT_BOOL(S, F)   emit_field(#F, offsetof(S, F), sizeof(((S*)0)->F), "bool")
#define EMIT_PTR(S, F)    emit_field(#F, offsetof(S, F), sizeof(((S*)0)->F), "ptr")
#define EMIT_STRUCT(S, F) emit_field(#F, offsetof(S, F), sizeof(((S*)0)->F), "struct")

static void end_struct(void) {
  printf("\n    ]\n  }");
}

/* ===== Probe each struct ===== */

static void probe_terminal_options(void) {
  /* FIELD LIST is authored from ABI discovery §5. At the pin this struct has
   * no `size` field — the first field is `cols:u16 @ 0`. Hardcode is_sized=0. */
  const int is_sized_options = 0;
  emit_struct("GhosttyTerminalOptions",
              sizeof(GhosttyTerminalOptions),
              _Alignof(GhosttyTerminalOptions),
              is_sized_options);
  first_field = 1;
  EMIT_UINT(GhosttyTerminalOptions, cols);           /* u16 @ 0 */
  EMIT_UINT(GhosttyTerminalOptions, rows);           /* u16 @ 2 */
  EMIT_UINT(GhosttyTerminalOptions, max_scrollback); /* u64 @ 8 (4 bytes pad @ 4-7) */
  /* NOTE: apc_max_bytes and apc_max_bytes_kitty are NOT fields on this struct.
   * They are set post-construction via ghostty_terminal_set(term,
   * GHOSTTY_TERMINAL_OPT_APC_MAX_BYTES, &limit) and ..._APC_MAX_BYTES_KITTY.
   * Pass 1 does not expose APC tuning — see Task 21 README APC footnote. */
  end_struct();
}

static void probe_formatter_terminal_options(void) {
  /* FIELD LIST is authored from ABI discovery §7. Sized struct (first field
   * is `size_t size`), 56 B, align 8. */
  const int is_sized = (offsetof(GhosttyFormatterTerminalOptions, size) == 0 &&
                        sizeof(((GhosttyFormatterTerminalOptions*)0)->size) == sizeof(size_t));
  emit_struct("GhosttyFormatterTerminalOptions",
              sizeof(GhosttyFormatterTerminalOptions),
              _Alignof(GhosttyFormatterTerminalOptions),
              is_sized);
  first_field = 1;
  EMIT_UINT(GhosttyFormatterTerminalOptions, size);       /* size_t @ 0 */
  EMIT_UINT(GhosttyFormatterTerminalOptions, emit);       /* u32 enum @ 8 (GhosttyFormatterFormat) */
  EMIT_BOOL(GhosttyFormatterTerminalOptions, unwrap);     /* bool @ 12 */
  EMIT_BOOL(GhosttyFormatterTerminalOptions, trim);       /* bool @ 13 (2 bytes pad @ 14-15) */
  EMIT_STRUCT(GhosttyFormatterTerminalOptions, extra);    /* struct(32) @ 16 */
  EMIT_PTR(GhosttyFormatterTerminalOptions, selection);   /* const GhosttySelection* @ 48 */
  end_struct();
}

static void probe_formatter_terminal_extra(void) {
  /* Nested inside GhosttyFormatterTerminalOptions.extra. 32 B, align 8, sized. */
  const int is_sized = (offsetof(GhosttyFormatterTerminalExtra, size) == 0 &&
                        sizeof(((GhosttyFormatterTerminalExtra*)0)->size) == sizeof(size_t));
  emit_struct("GhosttyFormatterTerminalExtra",
              sizeof(GhosttyFormatterTerminalExtra),
              _Alignof(GhosttyFormatterTerminalExtra),
              is_sized);
  first_field = 1;
  EMIT_UINT(GhosttyFormatterTerminalExtra, size);               /* size_t @ 0 */
  EMIT_BOOL(GhosttyFormatterTerminalExtra, palette);            /* bool @ 8 */
  EMIT_BOOL(GhosttyFormatterTerminalExtra, modes);              /* bool @ 9 */
  EMIT_BOOL(GhosttyFormatterTerminalExtra, scrolling_region);   /* bool @ 10 */
  EMIT_BOOL(GhosttyFormatterTerminalExtra, tabstops);           /* bool @ 11 (no underscore) */
  EMIT_BOOL(GhosttyFormatterTerminalExtra, pwd);                /* bool @ 12 */
  EMIT_BOOL(GhosttyFormatterTerminalExtra, keyboard);           /* bool @ 13 (2 bytes pad @ 14-15) */
  EMIT_STRUCT(GhosttyFormatterTerminalExtra, screen);           /* struct(16) @ 16 */
  end_struct();
}

static void probe_formatter_screen_extra(void) {
  /* Nested inside GhosttyFormatterTerminalExtra.screen. 16 B, align 8, sized. */
  const int is_sized = (offsetof(GhosttyFormatterScreenExtra, size) == 0 &&
                        sizeof(((GhosttyFormatterScreenExtra*)0)->size) == sizeof(size_t));
  emit_struct("GhosttyFormatterScreenExtra",
              sizeof(GhosttyFormatterScreenExtra),
              _Alignof(GhosttyFormatterScreenExtra),
              is_sized);
  first_field = 1;
  EMIT_UINT(GhosttyFormatterScreenExtra, size);            /* size_t @ 0 */
  EMIT_BOOL(GhosttyFormatterScreenExtra, cursor);          /* bool @ 8 */
  EMIT_BOOL(GhosttyFormatterScreenExtra, style);           /* bool @ 9 */
  EMIT_BOOL(GhosttyFormatterScreenExtra, hyperlink);       /* bool @ 10 */
  EMIT_BOOL(GhosttyFormatterScreenExtra, protection);      /* bool @ 11 */
  EMIT_BOOL(GhosttyFormatterScreenExtra, kitty_keyboard);  /* bool @ 12 */
  EMIT_BOOL(GhosttyFormatterScreenExtra, charsets);        /* bool @ 13 */
  end_struct();
}

/* ===== Pass 3: new structs ===== */

static void probe_color_rgb(void) {
  /* GhosttyColorRgb: 3 bytes tightly packed, no size field. */
  emit_struct("GhosttyColorRgb",
              sizeof(GhosttyColorRgb),
              _Alignof(GhosttyColorRgb),
              0);
  first_field = 1;
  EMIT_UINT(GhosttyColorRgb, r);
  EMIT_UINT(GhosttyColorRgb, g);
  EMIT_UINT(GhosttyColorRgb, b);
  end_struct();
}

static void probe_style_color(void) {
  /* GhosttyStyleColor: tag (i32) + value (union: palette u8 | rgb | _padding u64).
   * Not a sized struct. The union value is treated as a single opaque "struct" field. */
  emit_struct("GhosttyStyleColor",
              sizeof(GhosttyStyleColor),
              _Alignof(GhosttyStyleColor),
              0);
  first_field = 1;
  EMIT_INT(GhosttyStyleColor, tag);
  EMIT_STRUCT(GhosttyStyleColor, value);
  end_struct();
}

static void probe_style(void) {
  /* GhosttyStyle: sized struct (first field is size_t size).
   * fg_color, bg_color, underline_color are GhosttyStyleColor (tag+value union).
   * bool flags then int underline at the end. */
  const int is_sized = (offsetof(GhosttyStyle, size) == 0 &&
                        sizeof(((GhosttyStyle*)0)->size) == sizeof(size_t));
  emit_struct("GhosttyStyle",
              sizeof(GhosttyStyle),
              _Alignof(GhosttyStyle),
              is_sized);
  first_field = 1;
  EMIT_UINT(GhosttyStyle, size);
  EMIT_STRUCT(GhosttyStyle, fg_color);
  EMIT_STRUCT(GhosttyStyle, bg_color);
  EMIT_STRUCT(GhosttyStyle, underline_color);
  EMIT_BOOL(GhosttyStyle, bold);
  EMIT_BOOL(GhosttyStyle, italic);
  EMIT_BOOL(GhosttyStyle, faint);
  EMIT_BOOL(GhosttyStyle, blink);
  EMIT_BOOL(GhosttyStyle, inverse);
  EMIT_BOOL(GhosttyStyle, invisible);
  EMIT_BOOL(GhosttyStyle, strikethrough);
  EMIT_BOOL(GhosttyStyle, overline);
  EMIT_INT(GhosttyStyle, underline);
  end_struct();
}

static void probe_render_state_colors(void) {
  /* GhosttyRenderStateColors: sized struct with palette[256]. */
  const int is_sized = (offsetof(GhosttyRenderStateColors, size) == 0 &&
                        sizeof(((GhosttyRenderStateColors*)0)->size) == sizeof(size_t));
  emit_struct("GhosttyRenderStateColors",
              sizeof(GhosttyRenderStateColors),
              _Alignof(GhosttyRenderStateColors),
              is_sized);
  first_field = 1;
  EMIT_UINT(GhosttyRenderStateColors, size);
  EMIT_STRUCT(GhosttyRenderStateColors, background);
  EMIT_STRUCT(GhosttyRenderStateColors, foreground);
  EMIT_STRUCT(GhosttyRenderStateColors, cursor);
  EMIT_BOOL(GhosttyRenderStateColors, cursor_has_value);
  EMIT_STRUCT(GhosttyRenderStateColors, palette);
  end_struct();
}

static void probe_grid_ref(void) {
  /* GhosttyGridRef: sized struct: size(8) + node(ptr 8) + x(u16) + y(u16). */
  const int is_sized = (offsetof(GhosttyGridRef, size) == 0 &&
                        sizeof(((GhosttyGridRef*)0)->size) == sizeof(size_t));
  emit_struct("GhosttyGridRef",
              sizeof(GhosttyGridRef),
              _Alignof(GhosttyGridRef),
              is_sized);
  first_field = 1;
  EMIT_UINT(GhosttyGridRef, size);
  EMIT_PTR(GhosttyGridRef, node);
  EMIT_UINT(GhosttyGridRef, x);
  EMIT_UINT(GhosttyGridRef, y);
  end_struct();
}

static void probe_point_coordinate(void) {
  /* GhosttyPointCoordinate: x(u16) + y(u32). Not a sized struct. */
  emit_struct("GhosttyPointCoordinate",
              sizeof(GhosttyPointCoordinate),
              _Alignof(GhosttyPointCoordinate),
              0);
  first_field = 1;
  EMIT_UINT(GhosttyPointCoordinate, x);
  EMIT_UINT(GhosttyPointCoordinate, y);
  end_struct();
}

static void probe_point(void) {
  /* GhosttyPoint: tag(i32) + value(union: coordinate | _padding[2]). Not sized. */
  emit_struct("GhosttyPoint",
              sizeof(GhosttyPoint),
              _Alignof(GhosttyPoint),
              0);
  first_field = 1;
  EMIT_INT(GhosttyPoint, tag);
  EMIT_STRUCT(GhosttyPoint, value);
  end_struct();
}

static void probe_terminal_scroll_viewport(void) {
  /* GhosttyTerminalScrollViewport: tag(i32) + value(union: delta intptr | _padding[2]).
   * Not a sized struct. Value union treated as opaque "struct" field. */
  emit_struct("GhosttyTerminalScrollViewport",
              sizeof(GhosttyTerminalScrollViewport),
              _Alignof(GhosttyTerminalScrollViewport),
              0);
  first_field = 1;
  EMIT_INT(GhosttyTerminalScrollViewport, tag);
  EMIT_STRUCT(GhosttyTerminalScrollViewport, value);
  end_struct();
}

int main(void) {
  printf("{\n  \"structs\": [\n");
  probe_terminal_options();
  probe_formatter_terminal_options();
  probe_formatter_terminal_extra();
  probe_formatter_screen_extra();
  /* Pass 3 additions */
  probe_color_rgb();
  probe_style_color();
  probe_style();
  probe_render_state_colors();
  probe_grid_ref();
  probe_point_coordinate();
  probe_point();
  probe_terminal_scroll_viewport();
  printf("\n  ]\n}\n");
  return 0;
}
