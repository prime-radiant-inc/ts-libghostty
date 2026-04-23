#!/usr/bin/env bash
#
# Capture real-application VT byte streams for test/differential/corpus/.
#
# Each fixture runs under a PTY via scripts/capture-fixture.py, which gives
# programs the TTY they expect and records every byte they emit. The captured
# bytes are fed to both the C oracle and the TS binding by the differential
# harness; any divergence is a binding bug.
#
# Requirements: python3 (ships with macOS), vim, less, tmux, top, bash.
# htop is not on macOS by default; we use `top` as the macOS analog.
#
# Fixtures are not reproducible byte-for-byte across re-runs (outputs depend
# on process list, vim/less version, timing), but they exercise realistic
# sequence combinations that atomic fuzz seeds don't. Regenerate when:
#   - a tool's output format changes materially
#   - the Ghostty pin bumps and a fixture starts emitting sequences the new
#     VT interpreter handles differently
#
# Usage: bash scripts/capture-real-app-fixtures.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CORPUS="$REPO_ROOT/test/differential/corpus"
CAP="python3 $SCRIPT_DIR/capture-fixture.py --cols 80 --rows 24"

mkdir -p "$CORPUS"
cd "$REPO_ROOT"

# ---- 20-bash-prompt ---------------------------------------------------------
# A short bash session with a colored prompt running two commands. Exercises
# OSC/CSI runs typical of shell PS1 + command echo + output.
BASH_TMP="$(mktemp -d)"
cat > "$BASH_TMP/bashrc" <<'EOF'
PS1='\[\033[1;34m\]user@host\[\033[0m\]:\[\033[1;36m\]~/work\[\033[0m\]$ '
EOF
$CAP \
  --input 'echo hello world\n' \
  --input 'printf "\\033[1;31mred\\033[0m \\033[32mgreen\\033[0m\\n"\n' \
  --input 'exit\n' \
  --input-delay 200 \
  --timeout 6 \
  --output "$CORPUS/20-bash-prompt.vt" \
  -- bash --noprofile --rcfile "$BASH_TMP/bashrc" -i
rm -rf "$BASH_TMP"

# ---- 21-vim-edit ------------------------------------------------------------
# Plain vim edit (no syntax highlighting). Typing a couple of lines, cursor
# positioning, status line. Uses --clean to avoid user config noise.
#
# We deliberately do NOT send :q — quitting tells vim to exit the alt-screen
# (ESC [ ? 1049 l), which restores the empty main screen and erases all the
# rendered content from the fixture. Instead we capture and let the SIGKILL
# timeout fire, freezing the displayed state.
$CAP \
  --input 'iHello world\nLine two\nLine three\x1b' \
  --input ':w! /tmp/vim-edit-cap.txt\n' \
  --input-delay 250 \
  --timeout 3 \
  --output "$CORPUS/21-vim-edit.vt" \
  -- vim --clean -N
rm -f /tmp/vim-edit-cap.txt

# ---- 22-vim-syntax ----------------------------------------------------------
# Vim with syntax highlighting ON, opening a small Python file. Exercises SGR
# coloring heavily — the reason we run the differential harness in `vt` and
# `html` modes, not just `plain`. Color divergence would show up here. Same
# alt-screen rationale as 21: we let SIGKILL fire instead of sending :q.
VIM_TMP="$(mktemp -d)"
cat > "$VIM_TMP/sample.py" <<'EOF'
#!/usr/bin/env python3
"""A small colored-syntax sample."""

def greet(name: str) -> str:
    # comment line with "string in comment" and a number 42
    return f"Hello, {name}!"

if __name__ == "__main__":
    for i in range(3):
        print(greet(f"world {i}"))
EOF
$CAP \
  --input ':redraw\n' \
  --input-delay 600 \
  --timeout 3 \
  --output "$CORPUS/22-vim-syntax.vt" \
  -- vim --clean -N -c 'syntax on' -c 'set background=dark' "$VIM_TMP/sample.py"
rm -rf "$VIM_TMP"

# ---- 23-less-pager ----------------------------------------------------------
# Open a file in less, page down. Exercises alt-screen + scroll regions. As
# with vim, we do not send 'q' (quitting exits alt-screen and erases content);
# we let SIGKILL fire to freeze the displayed state.
LESS_TMP="$(mktemp)"
python3 -c "
for i in range(1, 51):
    print(f'Line {i:03d}: the quick brown fox jumps over the lazy dog.')
" > "$LESS_TMP"
$CAP \
  --input ' ' \
  --input ' ' \
  --input-delay 400 \
  --timeout 3 \
  --output "$CORPUS/23-less-pager.vt" \
  -- less -R "$LESS_TMP"
rm -f "$LESS_TMP"

# ---- 24-tmux-splits ---------------------------------------------------------
# Fresh tmux server (-L to isolate), single client, create a horizontal split,
# echo into each pane, then kill the server. Exercises alt-screen + per-pane
# cursor/scroll regions + pane-border drawing.
TMUX_SOCK="cap-fixture-$$"
# Start a detached session first so new-session+attach isn't subject to race
tmux -L "$TMUX_SOCK" -f /dev/null new-session -d -s s -x 80 -y 24 'bash --noprofile --norc'
$CAP \
  --input '\x02"' \
  --input 'echo pane one; read\n' \
  --input '\x02o' \
  --input 'echo pane two\n' \
  --input-delay 400 \
  --timeout 5 \
  --output "$CORPUS/24-tmux-splits.vt" \
  -- tmux -L "$TMUX_SOCK" -f /dev/null attach-session -t s
tmux -L "$TMUX_SOCK" kill-server 2>/dev/null || true

# ---- 25-top-snapshot --------------------------------------------------------
# macOS `top` (analog of htop). Two 1s samples and exit — deterministic
# output shape, albeit with non-deterministic content.
$CAP \
  --timeout 8 \
  --output "$CORPUS/25-top-snapshot.vt" \
  -- top -l 2 -s 1 -n 10 -o cpu

# ---- Summary ----------------------------------------------------------------
echo ""
echo "Captured fixtures:"
ls -la "$CORPUS"/2?-*.vt
