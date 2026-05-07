/*
 * libghostty-vt portability shim.
 *
 * Wraps the four "by-value struct" entry points with pointer-taking variants
 * so consumers can call them through bun:ffi without depending on platform-
 * specific calling-convention rules (AAPCS64 register-split vs SysV-amd64).
 *
 * Build (Linux):
 *   cc -O2 -fPIC -shared \
 *      -I /path/to/ghostty/include \
 *      -o libghostty-vt-shim.so ghostty-vt-shim.c \
 *      -L /path/to/libghostty-vt -lghostty-vt -Wl,-rpath,'$ORIGIN'
 */

#include "ghostty/vt.h"
#include "ghostty/vt/terminal.h"
#include "ghostty/vt/formatter.h"
#include "ghostty/vt/point.h"
#include "ghostty/vt/grid_ref.h"

#ifdef __GNUC__
#define EXPORT __attribute__((visibility("default")))
#else
#define EXPORT
#endif

EXPORT GhosttyResult
ghostty_terminal_new_p(const GhosttyAllocator *allocator,
                       GhosttyTerminal *out_terminal,
                       const GhosttyTerminalOptions *options) {
  return ghostty_terminal_new(allocator, out_terminal, *options);
}

EXPORT GhosttyResult
ghostty_formatter_terminal_new_p(const GhosttyAllocator *allocator,
                                 GhosttyFormatter *out_formatter,
                                 GhosttyTerminal terminal,
                                 const GhosttyFormatterTerminalOptions *options) {
  return ghostty_formatter_terminal_new(allocator, out_formatter, terminal,
                                        *options);
}

EXPORT GhosttyResult
ghostty_terminal_grid_ref_p(GhosttyTerminal terminal,
                            const GhosttyPoint *point,
                            GhosttyGridRef *out_ref) {
  return ghostty_terminal_grid_ref(terminal, *point, out_ref);
}

EXPORT void
ghostty_terminal_scroll_viewport_p(GhosttyTerminal terminal,
                                   const GhosttyTerminalScrollViewport *behavior) {
  ghostty_terminal_scroll_viewport(terminal, *behavior);
}
