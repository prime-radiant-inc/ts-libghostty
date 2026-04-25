/*
 * Differential testing oracle for ts-libghostty-vt.
 *
 * Reads VT bytes from a file, drives ghostty_terminal_vt_write, formats with
 * ghostty_formatter_terminal_new + ghostty_formatter_format_alloc, dumps the
 * result to stdout. The TS binding pipeline is run separately on the same
 * input; output is compared bytewise.
 *
 * Adapted from vendor/ghostty/example/c-vt-formatter/src/main.c.
 *
 * Usage:
 *   diff-oracle [--cols N] [--rows N] [--format plain|vt|html] <input-file>
 *
 * Exit codes:
 *   0  success (output written to stdout)
 *   1  argument or I/O error (message to stderr)
 *   2  Ghostty API failure (message to stderr; includes function + result code)
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "ghostty/vt.h"

static int parse_uint(const char *s, uint16_t *out) {
  char *end;
  long v = strtol(s, &end, 10);
  if (*end != '\0' || v <= 0 || v > UINT16_MAX) return -1;
  *out = (uint16_t)v;
  return 0;
}

static int parse_format(const char *s, GhosttyFormatterFormat *out) {
  if (strcmp(s, "plain") == 0) { *out = GHOSTTY_FORMATTER_FORMAT_PLAIN; return 0; }
  if (strcmp(s, "vt")    == 0) { *out = GHOSTTY_FORMATTER_FORMAT_VT;    return 0; }
  if (strcmp(s, "html")  == 0) { *out = GHOSTTY_FORMATTER_FORMAT_HTML;  return 0; }
  return -1;
}

static uint8_t *slurp(const char *path, size_t *out_len) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  struct stat st;
  if (fstat(fileno(f), &st) != 0) { fclose(f); return NULL; }
  size_t n = (size_t)st.st_size;
  uint8_t *buf = (uint8_t *)malloc(n > 0 ? n : 1);
  if (!buf) { fclose(f); return NULL; }
  size_t got = fread(buf, 1, n, f);
  fclose(f);
  if (got != n) { free(buf); return NULL; }
  *out_len = n;
  return buf;
}

static void usage(FILE *out) {
  fprintf(out,
    "usage: diff-oracle [--cols N] [--rows N] [--format plain|vt|html] <input-file>\n");
}

int main(int argc, char **argv) {
  uint16_t cols = 80;
  uint16_t rows = 24;
  GhosttyFormatterFormat fmt = GHOSTTY_FORMATTER_FORMAT_PLAIN;
  const char *input_path = NULL;

  for (int i = 1; i < argc; i++) {
    const char *a = argv[i];
    if (strcmp(a, "--cols") == 0 && i + 1 < argc) {
      if (parse_uint(argv[++i], &cols) != 0) {
        fprintf(stderr, "diff-oracle: invalid --cols value\n"); return 1;
      }
    } else if (strcmp(a, "--rows") == 0 && i + 1 < argc) {
      if (parse_uint(argv[++i], &rows) != 0) {
        fprintf(stderr, "diff-oracle: invalid --rows value\n"); return 1;
      }
    } else if (strcmp(a, "--format") == 0 && i + 1 < argc) {
      if (parse_format(argv[++i], &fmt) != 0) {
        fprintf(stderr, "diff-oracle: --format must be plain, vt, or html\n"); return 1;
      }
    } else if (strcmp(a, "-h") == 0 || strcmp(a, "--help") == 0) {
      usage(stdout); return 0;
    } else if (a[0] == '-') {
      fprintf(stderr, "diff-oracle: unknown flag: %s\n", a); return 1;
    } else if (input_path == NULL) {
      input_path = a;
    } else {
      fprintf(stderr, "diff-oracle: extra positional argument: %s\n", a); return 1;
    }
  }

  if (input_path == NULL) {
    usage(stderr);
    return 1;
  }

  size_t input_len = 0;
  uint8_t *input = slurp(input_path, &input_len);
  if (input == NULL) {
    fprintf(stderr, "diff-oracle: failed to read %s: %s\n", input_path, strerror(errno));
    return 1;
  }

  GhosttyTerminal terminal;
  GhosttyTerminalOptions term_opts = {
    .cols = cols,
    .rows = rows,
    .max_scrollback = 0,
  };
  GhosttyResult r = ghostty_terminal_new(NULL, &terminal, term_opts);
  if (r != GHOSTTY_SUCCESS) {
    fprintf(stderr, "diff-oracle: ghostty_terminal_new failed (%d)\n", r);
    free(input);
    return 2;
  }

  /* Feed input as a single chunk. Splitting into smaller chunks is a useful
   * stress test (parser state across chunk boundaries) but adds noise to v0;
   * defer to a separate corpus mode if needed. */
  ghostty_terminal_vt_write(terminal, input, input_len);
  free(input);

  /* Match the binding's defaults at the public API level: emit + trim are
   * explicit; everything else (extra.*) defaults to false. The TS binding's
   * Formatter passes the same shape via writeStruct() — see src/formatter.ts. */
  GhosttyFormatterTerminalOptions fmt_opts = GHOSTTY_INIT_SIZED(GhosttyFormatterTerminalOptions);
  fmt_opts.emit = fmt;
  fmt_opts.trim = true;

  GhosttyFormatter formatter;
  r = ghostty_formatter_terminal_new(NULL, &formatter, terminal, fmt_opts);
  if (r != GHOSTTY_SUCCESS) {
    fprintf(stderr, "diff-oracle: ghostty_formatter_terminal_new failed (%d)\n", r);
    ghostty_terminal_free(terminal);
    return 2;
  }

  uint8_t *buf = NULL;
  size_t len = 0;
  r = ghostty_formatter_format_alloc(formatter, NULL, &buf, &len);
  if (r != GHOSTTY_SUCCESS) {
    fprintf(stderr, "diff-oracle: ghostty_formatter_format_alloc failed (%d)\n", r);
    ghostty_formatter_free(formatter);
    ghostty_terminal_free(terminal);
    return 2;
  }

  if (len > 0) {
    if (fwrite(buf, 1, len, stdout) != len) {
      fprintf(stderr, "diff-oracle: stdout write failed\n");
      ghostty_free(NULL, buf, len);
      ghostty_formatter_free(formatter);
      ghostty_terminal_free(terminal);
      return 1;
    }
  }

  ghostty_free(NULL, buf, len);
  ghostty_formatter_free(formatter);
  ghostty_terminal_free(terminal);
  return 0;
}
