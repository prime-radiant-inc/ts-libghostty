#!/usr/bin/env bash
# Pack the current package into a tarball, install it into a throwaway
# directory, and run a minimal import-and-use script. Exits non-zero on any
# failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Ensure dist/ exists (the tarball relies on dist/ being built).
bun run build:ts

# Ensure tarball output directory exists.
mkdir -p "$ROOT/.tmp"

# Pack. Resolve the resulting tarball path relative to $ROOT, then make it
# absolute before using it as `file:` in the downstream package.json.
PACK_OUTPUT=$(bun pm pack --destination "$ROOT/.tmp" 2>&1)
REL=$(echo "$PACK_OUTPUT" | tail -n 1 | awk '{print $NF}')
if [ -z "${REL:-}" ] || [ ! -f "$REL" ]; then
  # Fallback — `bun pm pack` output format may vary. Find the most-recently-
  # created .tgz in .tmp/.
  REL=$(ls -1t "$ROOT/.tmp"/*.tgz 2>/dev/null | head -n 1)
fi
if [ -z "${REL:-}" ] || [ ! -f "$REL" ]; then
  echo "bun pm pack did not produce a tarball" >&2
  echo "$PACK_OUTPUT" >&2
  exit 1
fi
TGZ=$(cd "$(dirname "$REL")" && pwd)/$(basename "$REL")
echo "packed: $TGZ"

# Install into a temp project outside the repo.
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT
cd "$TMP"

cat > package.json <<EOF
{
  "name": "tarball-smoke",
  "type": "module",
  "dependencies": {
    "libghostty-vt": "file:$TGZ"
  }
}
EOF

bun install --silent

cat > run.ts <<'EOF'
import { Terminal, Formatter, RenderState, RectSizeMismatch, encodeFocus, KeyEncoder } from "libghostty-vt";

// Pass 1 — Terminal + Formatter
using term = new Terminal({ cols: 10, rows: 3 });
term.vtWrite(new TextEncoder().encode("hi"));
using fmt = new Formatter({ format: "plain" });
const s = fmt.formatString(term);
if (!s.includes("hi")) {
  console.error("expected 'hi' in output, got:", JSON.stringify(s));
  process.exit(1);
}

// Pass 3 — RenderState forEachCell
using rs = new RenderState();
rs.update(term);
let text = "";
rs.forEachCell(0, (cell) => { text += cell.text; });
if (!text.startsWith("hi")) {
  console.error("expected RenderState row 0 to start with 'hi', got:", JSON.stringify(text));
  process.exit(1);
}

// Pass 3 — Terminal.cellAt
const cell = term.cellAt({ x: 0, y: 0 });
if (cell?.text !== "h") {
  console.error("expected cellAt(0,0).text === 'h', got:", JSON.stringify(cell));
  process.exit(1);
}

// Pass 3 — encodeFocus
const focusBytes = encodeFocus("in");
if (focusBytes[0] !== 0x1B) {
  console.error("expected encodeFocus('in') to start with ESC, got:", Array.from(focusBytes));
  process.exit(1);
}

// Pass 4 — KeyEncoder
{
  using enc = new KeyEncoder({ options: {} });
  const bytes = enc.encode({ key: "KeyC", utf8: "c", unshiftedCodepoint: 0x63 });
  if (bytes.length !== 1 || bytes[0] !== 0x63) {
    console.error("KeyEncoder smoke failed: expected [0x63], got", Array.from(bytes));
    process.exit(1);
  }
  console.log("KeyEncoder smoke OK");
}

// Pass 4 / 0.4.0 surface — render-rect
{
  using t = new Terminal({ cols: 4, rows: 2 });
  t.vtWrite(new TextEncoder().encode("AB"));

  // Convenience method
  const out = t.renderToAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 });
  if (!out.includes("AB")) throw new Error("renderToAnsiRect missing content");

  // Primitive path
  using rrs = new RenderState();
  rrs.update(t);
  const primitive = rrs.toAnsiRect({ row: 1, col: 1, cols: 4, rows: 2 });
  if (out !== primitive) {
    throw new Error("convenience and primitive paths diverged");
  }

  // Cursor helper
  const c = rrs.cursorInRect({ row: 1, col: 1, cols: 4, rows: 2 });
  if (c === null) throw new Error("cursorInRect returned null unexpectedly");

  // Error path
  let threw = false;
  try { rrs.toAnsiRect({ row: 1, col: 1, cols: 5, rows: 2 }); }
  catch (e) { if (e instanceof RectSizeMismatch) threw = true; }
  if (!threw) throw new Error("RectSizeMismatch not thrown on size mismatch");

  console.log("render-rect smoke passed");
}

console.log("OK");
EOF

bun run.ts
